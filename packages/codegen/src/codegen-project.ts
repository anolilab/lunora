/**
 * Creates and refreshes the ts-morph project codegen reads, and locates its tsconfig.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { Project, ts } from "ts-morph";

import { listLunoraSourceFiles, listSecurityScanFiles } from "./discover/ast";

const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

/**
 * The exact set discovery reads: every non-`schema.ts` source file (the
 * canonical `listLunoraSourceFiles`, shared with function/migration discovery)
 * plus `schema.ts`, which `discoverSchema` loads separately. Reusing the
 * canonical walker keeps a freshly-built Project's file set in lockstep with a
 * refreshed one instead of forking the rules.
 */
const lunoraSeedFiles = (lunoraDirectory: string): string[] => {
    const paths = listLunoraSourceFiles(lunoraDirectory);
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        paths.push(schemaPath);
    }

    return paths;
};

/**
 * The `_generated/*.ts` files already on disk. `syncProjectFile` overwrites them in
 * place, a no-op when the content is unchanged, instead of creating them (a change)
 * when absent. Listed here so a cold start and a warm refresh hold the same set.
 */
const generatedSeedFiles = (lunoraDirectory: string): string[] => {
    const generatedDirectory = join(lunoraDirectory, "_generated");

    return existsSync(generatedDirectory)
        ? readdirSync(generatedDirectory)
              .filter((name) => name.endsWith(".ts"))
              .map((name) => join(generatedDirectory, name))
        : [];
};

/** Declaration files a tsconfig can list: `.d.ts`, `.d.mts` and `.d.cts`. */
const DECLARATION_FILE_RE = /\.d\.(?:ts|mts|cts)$/;

/** A global declaration that reaches the whole program: a `declare global` block or a triple-slash directive. */
const GLOBAL_DECLARATION_RE = /\bdeclare\s+global\b|\/\/\/\s*<reference\b/;

/** `declare module "x"` augmentations or ambient module declarations; the specifier is capture group 1. */
const MODULE_DECLARATION_RE = /\bdeclare\s+module\s+["']([^"']+)["']/g;

/**
 * The files the tsconfig includes. `files` entries are listed whether or not they
 * exist, so one wrangler has not generated yet is skipped here, not read and thrown on.
 */
const tsconfigFiles = (tsconfigPath: string): string[] => {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (): void => {} };

    return (ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, host)?.fileNames ?? []).filter((path) => existsSync(path));
};

/**
 * The tsconfig's `.d.ts` files. Ambient declarations (a generated
 * `worker-configuration.d.ts`, a `src/env.d.ts` augmenting a global) are only
 * ever pulled into a program by `include` — nothing imports them — yet types in
 * `lunora/` resolve against them. They are declarations only, so loading them is
 * cheap next to the app sources the seeding skips.
 */
const ambientDeclarationFiles = (tsconfigSources: string[]): string[] => tsconfigSources.filter((path) => DECLARATION_FILE_RE.test(path));

/** Each file's module status, keyed on mtime + size so a warm refresh does not re-parse it. */
const moduleFileCache = new Map<string, { isModule: boolean; key: string }>();

/**
 * Whether a file is a module, which is what keeps its declarations out of the program (a
 * script's are global). Asked of the TypeScript parser, which knows what is module syntax
 * and what is not: an `import` or `export` in a comment, string, regex, JSX text or
 * property name does not count, and neither does one inside a namespace.
 */
const isModuleFile = (path: string, text: string): boolean => {
    const stats = statSync(path);
    const key = `${String(stats.mtimeMs)}:${String(stats.size)}`;
    const cached = moduleFileCache.get(path);

    if (cached?.key === key) {
        return cached.isModule;
    }

    const isModule = ts.isExternalModule(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false));

    moduleFileCache.set(path, { isModule, key });

    return isModule;
};

/** Whether `text` imports or names `specifier` as a quoted module name, or a subpath of it (`"x/y"`). */
const namesModule = (text: string, specifier: string): boolean =>
    [`"${specifier}"`, `'${specifier}'`, `"${specifier}/`, `'${specifier}/`].some((quoted) => text.includes(quoted));

/**
 * The tsconfig's source files whose declarations reach `lunora/` with no import edge
 * to them: a script, a `declare global` or a triple-slash directive, which apply
 * program-wide. A `declare module "x"` applies only to a module `x` that `lunora/`
 * uses, so it counts only when a `lunora/` source names `x`; seeding every augmentation
 * would drag in the frontend that augments its router. Reads each file's text, not its AST.
 */
const globalDeclarationFiles = (tsconfigSources: string[], lunoraDirectory: string): string[] => {
    const lunoraText = lunoraSeedFiles(lunoraDirectory)
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
    const lunoraPrefix = `${toPosixPath(lunoraDirectory)}/`;

    return tsconfigSources.filter((path) => {
        if (DECLARATION_FILE_RE.test(path) || toPosixPath(path).startsWith(lunoraPrefix)) {
            return false;
        }

        const text = readFileSync(path, "utf8");

        if (GLOBAL_DECLARATION_RE.test(text) || !isModuleFile(path, text)) {
            return true;
        }

        return [...text.matchAll(MODULE_DECLARATION_RE)].some(([, specifier = ""]) => namesModule(lunoraText, specifier));
    });
};

/**
 * The source files one `runCodegen` reads or syncs, so a `"lunora"`-scope Project
 * holds them before the first type query: the sources under `lunora/`, the worker
 * entries and `lunora.config.*` the security lints scan, the `_generated/` files, and
 * the tsconfig's declarations and global declarations (see `globalDeclarationFiles`).
 * A file added AFTER the program exists throws the program (and its type checker,
 * the expensive part) away, so one left out here is not a missed file but a rebuild.
 */
const programSeedFiles = (lunoraDirectory: string, tsconfigPath: string | undefined): string[] => {
    const tsconfigSources = tsconfigPath === undefined ? [] : tsconfigFiles(tsconfigPath);

    return [
        ...new Set([
            ...lunoraSeedFiles(lunoraDirectory),
            ...listSecurityScanFiles(lunoraDirectory).map(({ filePath }) => filePath),
            ...generatedSeedFiles(lunoraDirectory),
            ...ambientDeclarationFiles(tsconfigSources),
            ...globalDeclarationFiles(tsconfigSources, lunoraDirectory),
        ]),
    ];
};

/**
 * Walk up from `startPath` until we find a `tsconfig.json` or hit the file
 * system root. Returns the absolute path to the tsconfig, or `undefined`.
 *
 *
 * Exported (see the bottom-of-file `export { findTsconfig }`) so a long-lived
 * caller (the Vite dev-loop's cached-Project invalidation) can ask "which
 * tsconfig would `createCodegenProject` resolve right now?" without
 * duplicating the walk — recomputing it per call is a handful of `existsSync`
 * checks, negligible next to a Project rebuild.
 */
export const findTsconfig = (startPath: string): string | undefined => {
    let directory = existsSync(startPath) ? startPath : dirname(startPath);

    while (directory && directory !== dirname(directory)) {
        const candidate = join(directory, "tsconfig.json");

        if (existsSync(candidate)) {
            return candidate;
        }

        directory = dirname(directory);
    }

    return undefined;
};

/**
 * Construct the ts-morph `Project` codegen discovers over. Prefers the user's
 * `tsconfig.json` (when one is found walking up from `lunoraDirectory`) so
 * cross-file type resolution and path aliases work; falls back to an isolated
 * project otherwise. This is the exact construction `runCodegen` uses
 * when no `project` is injected — exported so a long-lived caller (the Vite
 * dev-loop) can build one once and reuse it across runs via
 * {@link refreshCodegenProject} instead of re-parsing the user's whole TS
 * program on every save.
 *
 * The program is seeded with the `lunora/` sources, the tsconfig's ambient and global
 * declarations, and whatever those import. The app's UI and tests reach it only by
 * being imported, which is all type resolution needs, so a project whose tsconfig
 * includes a whole frontend does not pay to parse it on a cold run.
 */
export const createCodegenProject = (lunoraDirectory: string): Project => {
    const tsconfigPath = findTsconfig(lunoraDirectory);

    if (tsconfigPath === undefined) {
        return new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false });

    // `createSourceFile` from the text, not `addSourceFilesAtPaths`: adding a file that
    // sits directly in the project root (`lunora.config.ts`, a root
    // `worker-configuration.d.ts`) before the program exists makes ts-morph walk the
    // root's directory tree — `node_modules` included — and the run never finishes.
    for (const path of programSeedFiles(lunoraDirectory, tsconfigPath)) {
        project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true });
    }

    // Registers the local files those import (a validator shared from `src/`) as
    // Project files, which is what a tsconfig-scope Project gets from `include`.
    // Without it `refreshCodegenProject` cannot see them, and a reused Project
    // keeps serving the first copy it parsed. It builds the program here instead
    // of on the first type query — the same work, in a different place.
    project.resolveSourceFileDependencies();

    return project;
};

/**
 * Synchronise a reused `createCodegenProject` Project with the current
 * on-disk state of `lunoraDirectory`, so the next `runCodegen` sees the
 * same files a freshly-constructed Project would — without re-parsing the whole
 * TS program. Adds any on-disk source file the Project doesn't yet have, and
 * `refreshFromFileSystemSync()`es the ones it does (picking up edits); then
 * removes Project source files under `lunoraDirectory` that no longer exist on
 * disk (the classic stale-deleted-file cache bug).
 *
 * Files outside `lunoraDirectory` — e.g. a shared validator or type pulled in
 * via the user's tsconfig — are also `refreshFromFileSystemSync()`ed, but only
 * the ones already loaded into the Project; none are added. `resolveValidatorAlias`
 * (parse-validator.ts) follows `getAliasedSymbol()` across module boundaries, so a
 * validator defined outside `lunoraDirectory` is genuinely read from whatever
 * source the Project currently holds — leaving those files stale made a reused
 * Project (the Vite dev loop) silently disagree with a fresh one (`lunora
 * codegen`) about the same source. `node_modules` is excluded: its `.d.ts` set
 * dominates the file count and never changes mid dev-loop, so refreshing it would
 * reinstate close to the full re-parse cost this cache exists to avoid.
 */
export const refreshCodegenProject = (project: Project, lunoraDirectory: string): void => {
    // The cold-start set (see `programSeedFiles`). Keeping `_generated/` in it stops the
    // removal below from dropping them on every warm run. The tsconfig's declarations
    // too: one generated after the Project was built (a `worker-configuration.d.ts`
    // from `wrangler types`) is otherwise never added, so a warm run keeps resolving
    // types without it.
    const diskPaths = programSeedFiles(lunoraDirectory, findTsconfig(lunoraDirectory));

    for (const path of diskPaths) {
        const existing = project.getSourceFile(path);

        if (existing === undefined) {
            // From the text, as the cold start does: a root-level file added from disk
            // walks the project root's tree, `node_modules` included.
            project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true });
        } else {
            existing.refreshFromFileSystemSync();
        }
    }

    // Drop source files under the lunora directory that vanished from disk, so a
    // deleted query/table never lingers in the reused Project's discovery set.
    // `getFilePath()` is always POSIX while `diskPaths` carry the OS separator —
    // normalise both sides or the removal silently never fires on Windows.
    const onDisk = new Set(diskPaths.map((path) => toPosixPath(path)));
    const lunoraRoot = toPosixPath(lunoraDirectory);
    const lunoraPrefix = `${lunoraRoot}/`;

    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();

        if ((filePath === lunoraRoot || filePath.startsWith(lunoraPrefix)) && !onDisk.has(filePath)) {
            project.removeSourceFile(sourceFile);
        }
    }

    // Second pass: resync everything else the Project already has loaded (type
    // resolution reached past `lunoraDirectory` — a shared validator, a type
    // alias, whatever the user's tsconfig program pulled in). `node_modules` is
    // skipped on purpose (see docblock); a file under it never changes here.
    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();

        if (filePath === lunoraRoot || filePath.startsWith(lunoraPrefix) || filePath.includes("/node_modules/")) {
            continue;
        }

        try {
            sourceFile.refreshFromFileSystemSync();
        } catch {
            // Deleted (or unreadable) since it was loaded — drop it rather than
            // let a throw here wedge the dev loop. `refreshFromFileSystemSync`
            // already forgets a genuinely-deleted file on its own; this guard is
            // for the rarer I/O-error case (e.g. a permission change).
            project.removeSourceFile(sourceFile);
        }
    }

    // A file that gained an import since the Project was built is only registered
    // once its importer's text is current, so this runs after the pass above. Under
    // `"lunora"` scope nothing else registers it. A file added here is read from
    // disk at that moment, so it is current too.
    project.resolveSourceFileDependencies();
};
