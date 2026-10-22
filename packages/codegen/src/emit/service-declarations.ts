import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

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

/**
 * Directories the tree walk does not descend into, for their size: build output, dependencies and VCS data. A program file under
 * one is still covered by the directory stamps.
 */
const UNTRACKED_DIRECTORIES = new Set([".git", ".wrangler", "dist", "node_modules", "target"]);

/**
 * The symlinks in one `node_modules` directory (top level and `@scope` level), with their targets. A package manager repoints
 * a link on update without touching any file the service owns, and the program resolves through the link.
 */
const linkTargetsOf = (nodeModules: string): string[] =>
    readdirSync(nodeModules, { withFileTypes: true }).flatMap((entry) => {
        const path = join(nodeModules, entry.name);

        if (entry.isSymbolicLink()) {
            return [`${path}->${readlinkSync(path)}`];
        }

        return entry.isDirectory() && entry.name.startsWith("@") ? linkTargetsOf(path) : [];
    });

/**
 * The symlinks in every `node_modules` from `directory` up to the root, nearest first. TypeScript reaches a package through each of
 * them in turn, so a hoisted link above the service is as much an input as one in its own `node_modules`.
 */
const linkTargetsFrom = (directory: string): string[] => {
    const nodeModules = join(directory, "node_modules");
    const here = existsSync(nodeModules) ? linkTargetsOf(nodeModules) : [];
    const parent = dirname(directory);

    return parent === directory ? here : [...here, ...linkTargetsFrom(parent)];
};

/**
 * Every file under `directory` outside {@link UNTRACKED_DIRECTORIES}, with its stamp, and the symlink targets in the `node_modules`
 * from it up to the root. A file added here can shadow a module the program resolved (a `foo.ts` beside `foo/index.ts`). Undefined
 * when the tree cannot be read, so the caller treats the cache as a miss rather than as an unchanged tree.
 */
const treeStampOf = (directory: string): string | undefined => {
    const entries: string[] = [];

    try {
        const walk = (current: string): void => {
            for (const entry of readdirSync(current, { withFileTypes: true })) {
                const path = join(current, entry.name);

                if (entry.isDirectory()) {
                    if (!UNTRACKED_DIRECTORIES.has(entry.name)) {
                        // Checked again without following links: an entry swapped for a symlink after readdir is not descended into.
                        if (!lstatSync(path).isDirectory()) {
                            throw new Error(`${path} changed during the scan`);
                        }

                        walk(path);
                    }
                } else {
                    entries.push(`${path}:${stampOf(path)}`);
                }
            }
        };

        walk(directory);
        entries.push(...linkTargetsFrom(directory));
    } catch {
        return undefined;
    }

    return entries.toSorted((left, right) => left.localeCompare(right)).join("\n");
};

/** The `node_modules` directory a package sits in, stepping past its `@scope` directory when it has one. */
const modulesOf = (packageDirectory: string): string =>
    basename(dirname(packageDirectory)).startsWith("@") ? dirname(dirname(packageDirectory)) : dirname(packageDirectory);

/** A file of the service itself, rather than of a dependency. */
const isOwnSource = (path: string, serviceDirectory: string): boolean =>
    !relative(serviceDirectory, path).startsWith("..") && !path.split(sep).includes("node_modules");

/**
 * Adds the directories from `from` up to the nearest `package.json`, and that manifest, to `stamped`. Returns the directory the
 * manifest is in, or undefined — and then adds nothing: a walk to the root would stamp directories no package governs.
 */
const stampUpToManifest = (from: string, stamped: Set<string>): string | undefined => {
    const climbed: string[] = [];
    let directory = from;

    while (directory !== dirname(directory) && !existsSync(join(directory, "package.json"))) {
        climbed.push(directory);
        directory = dirname(directory);
    }

    if (!existsSync(join(directory, "package.json"))) {
        return undefined;
    }

    for (const path of [...climbed, directory, join(directory, "package.json")]) {
        stamped.add(path);
    }

    return directory;
};

/**
 * Adds the directories from `from` up to the first one that also contains the service, that common ancestor included. A file outside
 * any package and outside the service is found through those directories, so a file added to one of them can shadow it. The walk
 * stops at the common ancestor, so it never reaches above the tree the service and the file share.
 */
const stampBelowCommonAncestor = (from: string, serviceDirectory: string, stamped: Set<string>): void => {
    let directory = from;

    while (relative(directory, serviceDirectory).startsWith("..") && directory !== dirname(directory)) {
        stamped.add(directory);
        directory = dirname(directory);
    }

    stamped.add(directory);
};

/**
 * Every directory a program file sits in, with its stamp. A file added to one can become the candidate an import resolves to now:
 * in the service (`src/dist/sub.ts` beside `src/dist/sub/index.ts`, where `dist` is not walked) or in a package (`dist/sub.d.ts`
 * beside `dist/sub/index.d.ts`). Outside the service the walk stops at the `package.json` that governs the file, which is stamped
 * too: a changed `types` or `exports` target redirects an import without changing the file it used to name. With no such manifest
 * it stops at the common ancestor with the service instead.
 */
const directoryStampsOf = (paths: ReadonlyArray<string>, serviceDirectory: string): [path: string, stamp: string][] => {
    const stamped = new Set<string>();

    // Above the service, the nearest manifest decides a source's module format under NodeNext. Once for the service, not per file.
    if (paths.some((path) => isOwnSource(path, serviceDirectory))) {
        stampUpToManifest(serviceDirectory, stamped);
    }

    for (const path of paths) {
        if (isOwnSource(path, serviceDirectory)) {
            for (let directory = dirname(path); directory !== serviceDirectory && directory !== dirname(directory); directory = dirname(directory)) {
                stamped.add(directory);
            }

            continue;
        }

        const manifestDirectory = stampUpToManifest(dirname(path), stamped);

        if (manifestDirectory === undefined) {
            stampBelowCommonAncestor(dirname(path), serviceDirectory, stamped);
        } else {
            // The package's own dependencies are links beside it in the directory it sits in, so a relink moves that directory.
            stamped.add(modulesOf(manifestDirectory));
        }
    }

    return [...stamped].map((path): [string, string] => [path, stampOf(path)]);
};

interface CachedDeclarations {
    directories: [path: string, stamp: string][];
    files: Record<string, string>;
    optionsKey: string;
    stamps: [path: string, stamp: string][];
    tree: string;
}

// shortcut: never evicts. Not stamped: a specifier that resolved to nothing at emit time and is satisfied later; a package.json that appears above the service when none governed its sources at emit time (nothing is stamped above a service without one); and, on a filesystem with coarse mtimes, a write in the same second as a directory-based check. Upgrade by re-resolving the recorded specifiers on each hit when one of those is hit.
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
const freshDeclarations = (cacheKey: string, optionsKey: string, tree: string | undefined): Record<string, string> | undefined => {
    const cached = declarationCache.get(cacheKey);
    const fresh =
        cached?.optionsKey === optionsKey &&
        cached.stamps.every((stamp) => stillStamped(stamp)) &&
        cached.directories.every((stamp) => stillStamped(stamp)) &&
        tree !== undefined &&
        cached.tree === tree;

    return fresh ? cached.files : undefined;
};

/**
 * Keeps a snapshot for the next run. An unreadable tree leaves nothing to compare against, so nothing is kept and the next run
 * emits again rather than trust a stale tree. A file modified after the read started may have been read in its old state and
 * stamped in its new one; such a snapshot is not kept either. `readStartedAt` is wall-clock milliseconds, the clock mtimes use;
 * a write in the first millisecond of the read is missed, which costs nothing.
 */
const rememberDeclarations = (cacheKey: string, entry: Omit<CachedDeclarations, "tree"> & { tree: string | undefined }, readStartedAt: number): void => {
    const stampedBeforeRead = [...entry.stamps, ...entry.directories].every(([, stamp]) => Math.floor(Number.parseFloat(stamp)) <= readStartedAt);

    if (entry.tree !== undefined && stampedBeforeRead) {
        declarationCache.set(cacheKey, { ...entry, tree: entry.tree });
    }
};

/**
 * What a cached snapshot is checked against: every file the program resolved (external declarations included, however
 * far the import chain reaches), the directories those files sit in, and the service tree.
 */
const freshnessOf = (serviceDirectory: string, programPaths: ReadonlyArray<string>): Omit<CachedDeclarations, "files" | "optionsKey" | "tree"> => {
    return {
        directories: directoryStampsOf(programPaths, serviceDirectory),
        stamps: programPaths.map((path): [string, string] => [path, stampOf(path)]),
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
    // Taken before any source is read: a write during the read then changes the tree and misses the cache, instead of being recorded as emitted.
    const tree = treeStampOf(serviceDirectory);
    const cached = freshDeclarations(cacheKey, optionsKey, tree);

    if (cached !== undefined) {
        return cached;
    }

    const readStartedAt = Date.now();

    project.addSourceFileAtPath(service.main);
    project.resolveSourceFileDependencies();

    // The program, not ts-morph's source list: it holds the declarations an import chain reaches, which ts-morph does not keep.
    // ts-morph's bundled lib files have no path on disk; they are fixed by the installed version.
    const programPaths = project
        .getProgram()
        .compilerObject.getSourceFiles()
        .map((sourceFile) => sourceFile.fileName)
        .filter((path) => existsSync(path));
    const { directories, stamps } = freshnessOf(serviceDirectory, programPaths);

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

    rememberDeclarations(cacheKey, { files, optionsKey, directories, stamps, tree }, readStartedAt);

    return files;
};

export { emitServiceDeclarations, serviceDeclarationSpecifier };
