/**
 * Creates and refreshes the ts-morph project codegen reads, and locates its tsconfig.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";

import { listLunoraSourceFiles } from "./discover/ast";

const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

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
 */
export const createCodegenProject = (lunoraDirectory: string): Project => {
    const tsconfigPath = findTsconfig(lunoraDirectory);

    return tsconfigPath
        ? new Project({ skipAddingFilesFromTsConfig: false, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false })
        : new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
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
    // The exact set discovery reads: every non-`schema.ts` source file (the
    // canonical `listLunoraSourceFiles`, shared with function/migration
    // discovery) plus `schema.ts`, which `discoverSchema` loads separately.
    // Reusing the canonical walker keeps the reused Project's file set in
    // lockstep with a freshly-constructed one instead of forking the rules.
    const diskPaths = listLunoraSourceFiles(lunoraDirectory);
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        diskPaths.push(schemaPath);
    }

    for (const path of diskPaths) {
        const existing = project.getSourceFile(path);

        if (existing === undefined) {
            project.addSourceFileAtPath(path);
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
};
