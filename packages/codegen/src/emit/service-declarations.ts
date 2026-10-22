import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { Project, ts } from "ts-morph";

import type { ServiceBindingIR } from "../ir";
import { GENERATED_HEADER } from "./shared";

/** A source or declaration extension, with the `m`/`c` flavor captured. */
const SOURCE_EXTENSION_RE = /(?:\.d)?\.([cm]?)tsx?$/u;

/** `src/index.ts` → `src/index.d.ts` (`.mts` → `.d.mts`, `.cts` → `.d.cts`). */
const toDeclarationPath = (path: string): string => path.replace(SOURCE_EXTENSION_RE, ".d.$1ts");

/** A path as a relative, `.js`-suffixed specifier from `fromDirectory` — the form generated imports use under NodeNext. */
const toSpecifier = (fromDirectory: string, target: string): string => {
    const path = relative(fromDirectory, target).split(sep).join("/").replace(SOURCE_EXTENSION_RE, ".$1js");

    return path.startsWith(".") ? path : `./${path}`;
};

/** A path in POSIX form, as ts-morph reports it on every platform. */
const toPosix = (path: string): string => path.replaceAll("\\", "/");

/** The snapshot path of a service source file. */
const snapshotPathOf = (snapshotDirectory: string, serviceDirectory: string, source: string): string =>
    toPosix(join(snapshotDirectory, toDeclarationPath(relative(serviceDirectory, source))));

/** The `_generated/server.ts` import of an RPC service's entry declaration, e.g. `./services/gateway/src/index.js`. */
const serviceDeclarationSpecifier = (service: ServiceBindingIR): string =>
    toSpecifier(".", join("services", service.name, relative(dirname(service.wranglerPath), service.main)));

/** Every module specifier literal in a declaration file: `import`/`export … from`, and `import("…")` types. */
const moduleSpecifiers = (sourceFile: ts.SourceFile): ts.StringLiteral[] => {
    const found: ts.StringLiteral[] = [];

    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
            found.push(node.moduleSpecifier);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            found.push(node.argument.literal);
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return found;
};

/** A file's change stamp: modification time and size. */
const stampOf = (path: string): string => {
    const { mtimeMs, size } = statSync(path);

    return `${String(mtimeMs)}:${String(size)}`;
};

/** Directories no service source resolves through, and that can hold a large build tree. */
const UNTRACKED_DIRECTORIES = new Set([".git", ".wrangler", "dist", "node_modules", "target"]);

/**
 * Every file under `directory` outside {@link UNTRACKED_DIRECTORIES}, with its stamp. A file added here can shadow a module
 * the program resolved (a `foo.ts` beside `foo/index.ts`). Undefined when the tree cannot be read, so the caller treats the
 * cache as a miss rather than as an unchanged tree.
 */
const treeStampOf = (directory: string): string | undefined => {
    const entries: string[] = [];

    try {
        const walk = (current: string): void => {
            for (const entry of readdirSync(current, { withFileTypes: true })) {
                const path = join(current, entry.name);

                if (entry.isDirectory()) {
                    if (!UNTRACKED_DIRECTORIES.has(entry.name)) {
                        walk(path);
                    }
                } else {
                    entries.push(`${path}:${stampOf(path)}`);
                }
            }
        };

        walk(directory);
    } catch {
        return undefined;
    }

    return entries.toSorted((left, right) => left.localeCompare(right)).join("\n");
};

/**
 * The `package.json` that governs each file the program reached outside the service's own sources (node_modules included), with its stamp. A changed `types`
 * or `exports` target redirects an import without changing the file it used to name.
 */
const packageStampsOf = (paths: ReadonlyArray<string>, serviceDirectory: string): [path: string, stamp: string][] => {
    const manifests = new Set<string>();

    for (const path of paths) {
        const owned = !relative(serviceDirectory, path).startsWith("..") && !path.split(sep).includes("node_modules");

        if (owned) {
            continue;
        }

        let directory = dirname(path);

        while (directory !== dirname(directory) && !existsSync(join(directory, "package.json"))) {
            directory = dirname(directory);
        }

        if (existsSync(join(directory, "package.json"))) {
            manifests.add(join(directory, "package.json"));
        }
    }

    return [...manifests]
        .toSorted((left, right) => left.localeCompare(right))
        .flatMap((manifest): [string, string][] => [
            [manifest, stampOf(manifest)],
            [dirname(manifest), stampOf(dirname(manifest))],
        ]);
};

/**
 * What the service's own imports resolve to outside its sources, with `node_modules`. The program does not keep those
 * declaration files, so their manifests are found from the specifiers instead.
 */
const importedPathsOutside = (project: Project, serviceDirectory: string): string[] => {
    const options = project.getCompilerOptions();

    return project.getSourceFiles().flatMap((sourceFile) => {
        const path = sourceFile.getFilePath() as string;

        if (!relative(serviceDirectory, path).startsWith("..") && !path.split(sep).includes("node_modules")) {
            return sourceFile
                .getImportDeclarations()
                .map((declaration) => ts.resolveModuleName(declaration.getModuleSpecifierValue(), path, options, ts.sys).resolvedModule?.resolvedFileName)
                .filter((resolved): resolved is string => resolved !== undefined);
        }

        return [];
    });
};

interface CachedDeclarations {
    files: Record<string, string>;
    optionsKey: string;
    packages: [path: string, stamp: string][];
    stamps: [path: string, stamp: string][];
    tree: string;
}

// shortcut: never evicts, and a re-pointed pnpm link whose new target has the same package.json and no new file goes unseen; upgrade if a link is ever re-pointed in a checkout.
const declarationCache = new Map<string, CachedDeclarations>();

/** Whether `path` still has the stamp recorded for it; a path that has gone is stale. */
const stillStamped = ([path, stamp]: [path: string, stamp: string]): boolean => {
    try {
        return stampOf(path) === stamp;
    } catch {
        return false;
    }
};

/** The cached snapshot, while its compiler options, its program, its manifests and its service tree are unchanged on disk. */
const freshDeclarations = (cacheKey: string, optionsKey: string, serviceDirectory: string): Record<string, string> | undefined => {
    const cached = declarationCache.get(cacheKey);
    const tree = cached === undefined ? undefined : treeStampOf(serviceDirectory);
    const fresh =
        cached?.optionsKey === optionsKey &&
        cached.stamps.every((stamp) => stillStamped(stamp)) &&
        cached.packages.every((stamp) => stillStamped(stamp)) &&
        tree !== undefined &&
        cached.tree === tree;

    return fresh ? cached.files : undefined;
};

/**
 * Keeps a snapshot for the next run. An unreadable tree leaves nothing to compare against, so nothing is kept and the next run
 * emits again rather than trust a stale tree.
 */
const rememberDeclarations = (cacheKey: string, entry: Omit<CachedDeclarations, "tree"> & { tree: string | undefined }): void => {
    if (entry.tree !== undefined) {
        declarationCache.set(cacheKey, { ...entry, tree: entry.tree });
    }
};

/**
 * What a cached snapshot is checked against: the program's files and the external declaration files its imports resolve
 * to (with stamps), the manifests and package directories those came from, and the service tree.
 */
const freshnessOf = (
    project: Project,
    serviceDirectory: string,
    programPaths: ReadonlyArray<string>,
): Omit<CachedDeclarations, "files" | "optionsKey" | "tree"> & { tree: string | undefined } => {
    const outside = importedPathsOutside(project, serviceDirectory);
    const stampedPaths = [...programPaths, ...outside.filter((path) => existsSync(path))];

    return {
        packages: packageStampsOf([...programPaths, ...outside], serviceDirectory),
        stamps: stampedPaths.map((path): [string, string] => [path, stampOf(path)]),
        tree: treeStampOf(serviceDirectory),
    };
};

/**
 * A declaration snapshot of one RPC service (plan 457), keyed by path relative
 * to `_generated/`. The app types `ctx.services.<key>` from it instead of from
 * the service's sources, so the app's type check never compiles the service:
 * it is emitted under the service's own tsconfig, and `skipLibCheck` covers a
 * `.d.ts`. Every specifier is rewritten to resolve from `_generated/` — one into
 * the service to its snapshot sibling, any other to the file it resolved to from
 * the service (its own `node_modules`, which the app may not see). One that does
 * not resolve (an ambient module such as `cloudflare:workers`) is left as is.
 */
const emitServiceDeclarations = (service: ServiceBindingIR, generatedDirectory: string): Record<string, string> => {
    const serviceDirectory = dirname(service.wranglerPath);
    const relativeMain = relative(serviceDirectory, service.main);

    if (relativeMain.startsWith("..") || isAbsolute(relativeMain)) {
        throw new Error(`@lunora/codegen: service "${service.name}": its entry module (${service.main}) must be inside ${serviceDirectory} to be typed as RPC`);
    }

    const snapshotDirectory = join(generatedDirectory, "services", service.name);
    const tsConfigFilePath = ts.findConfigFile(serviceDirectory, (path) => ts.sys.fileExists(path));
    const project = new Project({
        compilerOptions: {
            composite: false,
            declaration: true,
            declarationMap: false,
            emitDeclarationOnly: true,
            incremental: false,
            noEmit: false,
            noEmitOnError: false,
            outDir: snapshotDirectory,
            rootDir: serviceDirectory,
        },
        skipAddingFilesFromTsConfig: true,
        ...(tsConfigFilePath === undefined ? {} : { tsConfigFilePath }),
    });

    // The emit type-checks the whole service; reuse it while its options and every file in its program are unchanged.
    const cacheKey = JSON.stringify([service.name, service.main, service.wranglerPath, generatedDirectory]);
    const optionsKey = JSON.stringify(project.getCompilerOptions());
    const cached = freshDeclarations(cacheKey, optionsKey, serviceDirectory);

    if (cached !== undefined) {
        return cached;
    }

    project.addSourceFileAtPath(service.main);
    project.resolveSourceFileDependencies();

    // ts-morph's bundled lib files have no path on disk; they are fixed by the installed version.
    const programPaths = project
        .getSourceFiles()
        .map((sourceFile) => sourceFile.getFilePath() as string)
        .filter((path) => existsSync(path));
    const { packages, stamps, tree } = freshnessOf(project, serviceDirectory, programPaths);

    // Symlinks kept, so a resolved path is in the same tree as `_generated/` (a temp dir or a pnpm link may be one).
    const compilerOptions = { ...project.getCompilerOptions(), preserveSymlinks: true };
    const sources = new Map(
        project
            .getSourceFiles()
            .map((sourceFile) => sourceFile.getFilePath() as string)
            .filter((path) => !path.endsWith(".d.ts") && !relative(serviceDirectory, path).startsWith(".."))
            .map((path) => [snapshotPathOf(snapshotDirectory, serviceDirectory, path), path]),
    );
    const files: Record<string, string> = {};

    for (const output of project.emitToMemory({ emitOnlyDtsFiles: true }).getFiles()) {
        const sourcePath = sources.get(toPosix(output.filePath));

        // A source outside the service (a linked workspace package) is reached through its resolved path below, not snapshotted.
        if (sourcePath === undefined) {
            continue;
        }

        const declaration = ts.createSourceFile(output.filePath, output.text, ts.ScriptTarget.Latest, false);
        let { text } = output;

        for (const literal of moduleSpecifiers(declaration).toReversed()) {
            const resolved = ts.resolveModuleName(literal.text, sourcePath, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;

            if (resolved === undefined) {
                continue;
            }

            const snapshotTarget = snapshotPathOf(snapshotDirectory, serviceDirectory, resolved);
            const target = sources.has(snapshotTarget) ? snapshotTarget : resolved;

            text = `${text.slice(0, literal.getStart(declaration))}${JSON.stringify(toSpecifier(dirname(output.filePath), target))}${text.slice(literal.getEnd())}`;
        }

        files[relative(generatedDirectory, output.filePath)] = `${GENERATED_HEADER}${text}`;
    }

    // `server.ts` imports the entry's snapshot; name the cause here rather than leave an unresolved import in generated code.
    if (files[relative(generatedDirectory, snapshotPathOf(snapshotDirectory, serviceDirectory, service.main))] === undefined) {
        throw new Error(`@lunora/codegen: service "${service.name}": TypeScript emitted no declaration for its entry module ${service.main}`);
    }

    rememberDeclarations(cacheKey, { files, optionsKey, packages, stamps, tree });

    return files;
};

export { emitServiceDeclarations, serviceDeclarationSpecifier };
