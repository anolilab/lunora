import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BUNDLE_META_PATH_ENV, DEFAULT_BUNDLE_META_PATH } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bundleMetaPlugin from "../src/bundle-meta-plugin";

let projectRoot: string;

/** The subset of Rollup's chunk shape the plugin reads. */
const chunk = (overrides: Record<string, unknown>) => {
    return {
        code: "export default {};\n",
        dynamicImports: [],
        imports: [],
        modules: {},
        type: "chunk",
        ...overrides,
    };
};

describe("bundleMetaPlugin", () => {
    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-bundle-meta-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("keeps the CLI's metafile when the project is reached through a symlink", () => {
        expect.assertions(1);

        const real = join(projectRoot, "real-app");
        const link = join(projectRoot, "linked-app");

        mkdirSync(join(real, "src"), { recursive: true });
        symlinkSync(real, link);

        const requested = join(link, ".lunora", "vite-bundle-meta-run.json");

        process.env[BUNDLE_META_PATH_ENV] = requested;

        try {
            const plugin = bundleMetaPlugin(link);
            const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

            generateBundle.call(
                { environment: { name: "ssr" }, getModuleInfo: () => undefined },
                {},
                { "index.js": chunk({ facadeModuleId: join(link, "src", "index.ts"), modules: {} }) },
            );

            expect(existsSync(join(real, ".lunora", "vite-bundle-meta-run.json"))).toBe(true);
        } finally {
            Reflect.deleteProperty(process.env, BUNDLE_META_PATH_ENV);
        }
    });

    it("ignores a metafile path outside its own .lunora, which a nested build for another project inherits", () => {
        expect.assertions(2);

        const foreign = join(projectRoot, "elsewhere", "app-meta.json");

        process.env[BUNDLE_META_PATH_ENV] = foreign;

        try {
            const plugin = bundleMetaPlugin(projectRoot);
            const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

            generateBundle.call(
                { environment: { name: "ssr" }, getModuleInfo: () => undefined },
                {},
                { "index.js": chunk({ facadeModuleId: join(projectRoot, "src", "index.ts"), modules: {} }) },
            );

            expect(existsSync(foreign)).toBe(false);
            expect(existsSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH))).toBe(true);
        } finally {
            Reflect.deleteProperty(process.env, BUNDLE_META_PATH_ENV);
        }
    });

    it("counts a module's rendered bytes, so non-ASCII text is not undercounted", () => {
        expect.assertions(1);

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

        generateBundle.call(
            { environment: { name: "ssr" }, getModuleInfo: () => undefined },
            {},
            {
                "index.js": chunk({
                    facadeModuleId: join(projectRoot, "src", "index.ts"),
                    modules: { [join(projectRoot, "src", "index.ts")]: { code: "é".repeat(10), renderedLength: 10 } },
                }),
            },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as {
            outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
        };

        // Ten "é" are twenty UTF-8 bytes; the string length would say ten.
        expect(meta.outputs["index.js"]?.inputs["src/index.ts"]).toStrictEqual({ bytesInOutput: 20 });
    });

    it("writes the server bundle's modules and outputs in esbuild metafile shape, under .lunora", () => {
        expect.assertions(4);

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;
        const context = {
            environment: { name: "ssr" },
            getModuleInfo: () => {
                return { dynamicallyImportedIds: [], importedIds: [join(projectRoot, "src", "b.ts")] };
            },
        };

        generateBundle.call(
            context,
            {},
            {
                "index.js": chunk({
                    facadeModuleId: join(projectRoot, "src", "index.ts"),
                    imports: ["chunk.js"],
                    modules: { [join(projectRoot, "src", "index.ts")]: { code: "a".repeat(42), renderedLength: 42 } },
                }),
                "assets/style.css": { type: "asset" },
            },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as {
            inputs: Record<string, { bytes: number; imports: { path: string }[] }>;
            outputs: Record<string, { bytes: number; entryPoint: string; imports: { path: string }[]; inputs: Record<string, { bytesInOutput: number }> }>;
        };

        expect(Object.keys(meta.outputs)).toEqual(["index.js"]);
        expect(meta.outputs["index.js"]?.inputs).toEqual({ "src/index.ts": { bytesInOutput: 42 } });
        expect(meta.outputs["index.js"]).toMatchObject({ entryPoint: "src/index.ts", imports: [{ kind: "import-statement", path: "chunk.js" }] });
        expect(meta.inputs["src/index.ts"]?.imports).toEqual([{ kind: "import-statement", path: "src/b.ts" }]);
    });

    it("records a lazy function's import() as a dynamic-import edge, on the output and on the importing module", () => {
        expect.assertions(2);

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;
        const entry = join(projectRoot, "src", "index.ts");
        const context = {
            environment: { name: "ssr" },
            getModuleInfo: () => {
                return { dynamicallyImportedIds: [join(projectRoot, "src", "fn", "a.ts")], importedIds: [] };
            },
        };

        generateBundle.call(
            context,
            {},
            {
                "index.js": chunk({ dynamicImports: ["fn-a.js"], facadeModuleId: entry, modules: { [entry]: { renderedLength: 10 } } }),
            },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as {
            inputs: Record<string, { imports: { kind: string; path: string }[] }>;
            outputs: Record<string, { imports: { kind: string; path: string }[] }>;
        };

        expect(meta.outputs["index.js"]?.imports).toEqual([{ kind: "dynamic-import", path: "fn-a.js" }]);
        expect(meta.inputs["src/index.ts"]?.imports).toEqual([{ kind: "dynamic-import", path: "src/fn/a.ts" }]);
    });

    it("sizes a query-suffixed import such as ?raw by the file it names", () => {
        expect.assertions(1);

        const file = join(projectRoot, "src", "data.txt");

        mkdirSync(join(projectRoot, "src"), { recursive: true });
        writeFileSync(file, "hello", "utf8");

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

        generateBundle.call(
            { environment: { name: "ssr" }, getModuleInfo: () => undefined },
            {},
            { "index.js": chunk({ modules: { [`${file}?raw`]: { renderedLength: 5 } } }) },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as { inputs: Record<string, { bytes: number }> };

        expect(meta.inputs["src/data.txt?raw"]?.bytes).toBe(5);
    });

    it("sizes a source file whose directory name contains # by its whole path", () => {
        expect.assertions(1);

        const file = join(projectRoot, "my#app", "src", "data.txt");

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "hello", "utf8");

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

        generateBundle.call(
            { environment: { name: "ssr" }, getModuleInfo: () => undefined },
            {},
            { "index.js": chunk({ modules: { [file]: { renderedLength: 5 } } }) },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as { inputs: Record<string, { bytes: number }> };

        expect(meta.inputs["my#app/src/data.txt"]?.bytes).toBe(5);
    });

    it("writes no metafile when a second server environment writes in the same build, rather than guessing which is the app's", () => {
        expect.assertions(1);

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;
        const bundle = { "index.js": chunk({}) };
        const warn = vi.fn<(message: string) => void>();

        generateBundle.call({ environment: { name: "app" }, getModuleInfo: () => undefined, warn }, {}, bundle);
        generateBundle.call({ environment: { name: "service" }, getModuleInfo: () => undefined, warn }, {}, bundle);

        expect(existsSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH))).toBe(false);
    });

    it("warns, naming both environments, when a second server environment leaves no metafile", () => {
        expect.assertions(2);

        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;
        const bundle = { "index.js": chunk({}) };
        const warn = vi.fn<(message: string) => void>();

        generateBundle.call({ environment: { name: "app" }, getModuleInfo: () => undefined, warn }, {}, bundle);
        generateBundle.call({ environment: { name: "service" }, getModuleInfo: () => undefined, warn }, {}, bundle);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/"service"[\s\S]*"app"[\s\S]*no bundle-meta\.json is written/);
    });

    it("sizes a virtual module by its transformed code in UTF-8 bytes, since it has no file", () => {
        expect.assertions(1);

        const virtualId = "\0lunora:worker";
        const code = "export default 'é€';\n";
        const plugin = bundleMetaPlugin(projectRoot);
        const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

        generateBundle.call(
            {
                environment: { name: "ssr" },
                getModuleInfo: () => {
                    return { code, dynamicallyImportedIds: [], importedIds: [] };
                },
            },
            {},
            { "index.js": chunk({ modules: { [virtualId]: { renderedLength: 10 } } }) },
        );

        const meta = JSON.parse(readFileSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH), "utf8")) as { inputs: Record<string, { bytes: number }> };

        expect(meta.inputs[virtualId]?.bytes).toBe(Buffer.byteLength(code));
    });

    it("writes the default metafile when the path variable is set but empty", () => {
        expect.assertions(1);

        vi.stubEnv(BUNDLE_META_PATH_ENV, "");

        try {
            const plugin = bundleMetaPlugin(projectRoot);
            const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

            generateBundle.call({ environment: { name: "ssr" }, getModuleInfo: () => undefined }, {}, {});

            expect(existsSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH))).toBe(true);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("applies to the server environment only, so the client bundle is not measured as the worker", () => {
        expect.assertions(2);

        const plugin = bundleMetaPlugin(projectRoot);
        const applyToEnvironment = plugin.applyToEnvironment as (environment: unknown) => boolean;

        expect(applyToEnvironment({ config: { consumer: "server" } })).toBe(true);
        expect(applyToEnvironment({ config: { consumer: "client" } })).toBe(false);
    });

    it("writes to the per-run path that lunora build names through the env var, relative to the project root", () => {
        expect.assertions(2);

        vi.stubEnv(BUNDLE_META_PATH_ENV, join(".lunora", "vite-bundle-meta-42.json"));

        try {
            const plugin = bundleMetaPlugin(projectRoot);
            const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;

            generateBundle.call({ environment: { name: "ssr" }, getModuleInfo: () => undefined }, {}, {});

            expect(existsSync(join(projectRoot, ".lunora", "vite-bundle-meta-42.json"))).toBe(true);
            expect(existsSync(join(projectRoot, DEFAULT_BUNDLE_META_PATH))).toBe(false);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
