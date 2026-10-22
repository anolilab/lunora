import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { BUNDLE_META_PATH_ENV, DEFAULT_BUNDLE_META_PATH } from "@lunora/config";
import type { Plugin } from "vite";

import toPosixPath from "./to-posix-path";

type ImportKind = "dynamic-import" | "import-statement";

interface MetafileImport {
    kind: ImportKind;
    path: string;
}

interface MetafileInput {
    bytes: number;
    imports: MetafileImport[];
}

interface MetafileOutput {
    bytes: number;
    entryPoint?: string;
    imports: MetafileImport[];
    inputs: Record<string, { bytesInOutput: number }>;
}

/** Module ids are absolute paths, except virtual ones (`\0…`), which stay as given. Keys use `/` on every OS, as chunk names do. */
const toKey = (projectRoot: string, id: string): string => (isAbsolute(id) ? toPosixPath(relative(projectRoot, id)) : id);

/** Tagged static or dynamic, as esbuild's metafile does: a lazy function's `import()` is a dynamic edge. */
const importEdges = (projectRoot: string, ids: ReadonlyArray<string>, kind: ImportKind): MetafileImport[] =>
    ids.map((id) => {
        return { kind, path: toKey(projectRoot, id) };
    });

// Module ids can end in a query such as `?raw`. Only tried after the whole id fails, because `#` and `?` can be part of a path.
const QUERY_OR_FRAGMENT = /[?#]/;

const statSize = (path: string): number | undefined => {
    try {
        return statSync(path).size;
    } catch {
        return undefined;
    }
};

/**
 * Size of the source file behind a module id. A virtual module has no file, so its transformed code is measured instead;
 * the bytes are UTF-8, since that is what the startup ceiling counts.
 */
const sourceBytes = (id: string, code: string | null | undefined): number =>
    statSize(id) ?? statSize(id.split(QUERY_OR_FRAGMENT)[0] ?? id) ?? Buffer.byteLength(code ?? "");

/**
 * Write the server bundle's module graph as an esbuild-shaped metafile
 * (`inputs` and `outputs`, each with `bytes` and `imports`), so the same reader
 * handles a Vite build and a wrangler one.
 *
 * Written from `generateBundle` of the server environment only. The file sits in
 * `.lunora/`, never in the worker's output directory: wrangler uploads whatever
 * it finds there, and a JSON file would become a module.
 */
const bundleMetaPlugin = (projectRoot: string): Plugin => {
    // The server environment that wrote this build's metafile, so a second one can be detected.
    let writtenBy: string | undefined;

    return {
        apply: "build",
        applyToEnvironment: (environment) => environment.config.consumer === "server",
        name: "lunora:bundle-meta",
        generateBundle(_options, bundle) {
            const inputs: Record<string, MetafileInput> = {};
            const outputs: Record<string, MetafileOutput> = {};

            for (const [fileName, chunk] of Object.entries(bundle)) {
                if (chunk.type !== "chunk") {
                    continue;
                }

                const output: MetafileOutput = {
                    bytes: Buffer.byteLength(chunk.code),
                    imports: [
                        ...importEdges(projectRoot, chunk.imports, "import-statement"),
                        ...importEdges(projectRoot, chunk.dynamicImports, "dynamic-import"),
                    ],
                    inputs: {},
                };

                if (chunk.facadeModuleId) {
                    output.entryPoint = toKey(projectRoot, chunk.facadeModuleId);
                }

                for (const [id, module] of Object.entries(chunk.modules)) {
                    const key = toKey(projectRoot, id);

                    // Bytes, not characters: a non-ASCII module renders more bytes than its string length.
                    output.inputs[key] = { bytesInOutput: Buffer.byteLength(module.code ?? "") };

                    if (!inputs[key]) {
                        const info = this.getModuleInfo(id);

                        inputs[key] = {
                            bytes: sourceBytes(id, info?.code),
                            imports: [
                                ...importEdges(projectRoot, info?.importedIds ?? [], "import-statement"),
                                ...importEdges(projectRoot, info?.dynamicallyImportedIds ?? [], "dynamic-import"),
                            ],
                        };
                    }
                }

                outputs[fileName] = output;
            }

            // The CLI names a per-run file so two builds in one project cannot read each other's.
            const override = process.env[BUNDLE_META_PATH_ENV];
            const metaPath = resolve(projectRoot, override === undefined || override === "" ? DEFAULT_BUNDLE_META_PATH : override);

            // Only one server environment's graph can be the app's, and the CLI cannot tell which. A second one leaves no metafile:
            // a missing file is honest, a wrong one is not. Named in a warning, since the missing file alone explains nothing.
            if (writtenBy !== undefined && writtenBy !== this.environment.name) {
                rmSync(metaPath, { force: true });
                this.warn(
                    `bundle-meta: environment "${this.environment.name}" built a server bundle after "${writtenBy}" wrote one; ` +
                        "no bundle-meta.json is written, because the app's own graph cannot be told apart from a service's",
                );

                return;
            }

            writtenBy = this.environment.name;

            mkdirSync(dirname(metaPath), { recursive: true });
            writeFileSync(metaPath, `${JSON.stringify({ inputs, outputs }, undefined, 2)}\n`, "utf8");
        },
    };
};

export default bundleMetaPlugin;
