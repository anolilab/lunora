/**
 * What a Lunora project's **worker entry** says about itself, read once.
 *
 * Two wrangler validations depend on facts that only the entry file can answer —
 * which Durable Object / Workflow classes it exports, and whether it chains
 * `.vectors(...)` onto `defineApp()`. Both used to resolve the path, read the
 * file, spin up their own ts-morph `Project` and run their own fail-open
 * diagnostics gate, which meant two full parses of the same file on every
 * `lunora verify` and every `lunora dev` restart, and two copies of a fail-open
 * policy that had to stay in sync by hand.
 *
 * {@link readWorkerEntry} does it once and hands back both answers. The checks
 * that consume them stay next to the wrangler config types they also read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import type { Node, SourceFile } from "ts-morph";
import { Node as TsNode, Project } from "ts-morph";

import { COMPOSED_WORKER_ENTRY, LUNORA_WORKER_VIRTUAL_ID, WORKER_ENTRY_FALLBACKS } from "../infer-bindings";
import join from "../path";

/**
 * Extensions this check will read. A class-B `main` can name the framework
 * adapter's BUILD OUTPUT (`.svelte-kit/cloudflare/_worker.js`, `dist/_worker.js`),
 * which exports only the SSR fetch handler — every declared class reads as
 * unexported there. Today the composed `src/worker.ts` shadows that case, but
 * the finding now blocks a deploy, so a bundle is skipped rather than trusted:
 * an authored Lunora entry is TypeScript.
 */
const WORKER_ENTRY_SOURCE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

/**
 * Resolve the worker entry the way `lunora deploy` bundles it: the class-B
 * composed entry when present (it is passed to wrangler as the positional
 * script, overriding `main`), else `wrangler.main` relative to the config file,
 * else the conventional fallbacks.
 *
 * Returns `undefined` for anything this check must not judge — a missing file, a
 * build artifact, or the class-A virtual specifier, which names no file at all.
 */
const resolveWorkerEntryPath = (main: string | undefined, projectRoot: string, wranglerPath: string): string | undefined => {
    const composed = join(projectRoot, COMPOSED_WORKER_ENTRY);

    if (existsSync(composed)) {
        return composed;
    }

    if (main === LUNORA_WORKER_VIRTUAL_ID) {
        return undefined;
    }

    if (typeof main === "string" && main.length > 0) {
        const resolved = join(dirname(wranglerPath), main);

        return existsSync(resolved) && WORKER_ENTRY_SOURCE_EXTENSIONS.has(extname(resolved)) ? resolved : undefined;
    }

    return WORKER_ENTRY_FALLBACKS.map((fallback) => join(projectRoot, fallback)).find((candidate) => existsSync(candidate));
};

/**
 * Every name a binding pattern binds — `{ ShardDO }`, `{ a: b }`, `[x]`, and
 * nests of those. `export const { ShardDO } = app;` is the generated app
 * builder's own pattern, so this is not an exotic form.
 */
const collectBindingNames = (nameNode: Node, names: Set<string>): void => {
    if (TsNode.isIdentifier(nameNode)) {
        names.add(nameNode.getText());

        return;
    }

    if (TsNode.isObjectBindingPattern(nameNode) || TsNode.isArrayBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
            if (TsNode.isBindingElement(element)) {
                collectBindingNames(element.getNameNode(), names);
            }
        }
    }
};

/** The names an `export { … }` / `export … from "…"` clause binds as values. */
const collectClauseExports = (sourceFile: SourceFile, names: Set<string>): boolean => {
    let opaque = false;

    for (const declaration of sourceFile.getExportDeclarations()) {
        if (declaration.isTypeOnly()) {
            continue;
        }

        // Only a STAR re-export is opaque, and `isNamespaceExport()` is the one
        // predicate that identifies it. Testing "no named exports" instead also
        // caught `export {}` — which binds nothing and is a routine way to mark
        // a file as a module — and one of those anywhere in the entry silently
        // turned this whole check off. That is worse than the bug it exists to
        // catch, because it reads as a pass.
        if (declaration.isNamespaceExport()) {
            const namespaceExport = declaration.getNamespaceExport();

            if (namespaceExport === undefined) {
                // A bare `export * from "./x"` forwards names that live in
                // another module, so the ABSENCE of a class name proves nothing.
                opaque = true;
            } else {
                // `export * as ns from "…"` binds only `ns`, so it forwards
                // nothing a class name could hide behind.
                names.add(namespaceExport.getName());
            }

            continue;
        }

        for (const specifier of declaration.getNamedExports()) {
            // For `export { Local as Bound }` the EXPORTED name is what wrangler
            // binds. A leading `type` is scoped per specifier — a whole-file
            // check let an unrelated `export type { X as … }` suppress a real
            // `export { X }`.
            if (!specifier.isTypeOnly()) {
                names.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
            }
        }
    }

    return opaque;
};

/**
 * The names declaration-form exports bind (`export class X`, `export const { X } = app`).
 *
 * Keyed on the `export` MODIFIER, never on `isExported()`. ts-morph answers
 * `isExported()` true for a class named by any export clause, alias and all — so
 * `class SchedulerDO {}` beside `export { SchedulerDO as SomethingElse }` read
 * as exporting `SchedulerDO`, which is the one name wrangler does NOT bind. The
 * clause walk above already records the exported name; this pass must only add
 * declarations that carry the keyword themselves, or it double-counts the local
 * one and misses the very rename the tests pin.
 */
const collectDeclarationExports = (sourceFile: SourceFile, names: Set<string>): void => {
    for (const statement of sourceFile.getVariableStatements().filter((candidate) => candidate.getExportKeyword() !== undefined)) {
        for (const declaration of statement.getDeclarations()) {
            collectBindingNames(declaration.getNameNode(), names);
        }
    }

    for (const declaration of [...sourceFile.getClasses(), ...sourceFile.getFunctions(), ...sourceFile.getEnums()]) {
        // `export default class X` binds `default`, not `X`, so a default
        // export never satisfies a `class_name`.
        const name = declaration.getExportKeyword() !== undefined && !declaration.isDefaultExport() ? declaration.getName() : undefined;

        if (name !== undefined) {
            names.add(name);
        }
    }
};

/** The generated app-composition entry point, whatever the entry chose to call it locally. */
const APP_FACTORY = "defineApp";

/**
 * The local names `defineApp` is bound to in this file — plural because
 * `import { defineApp as createApp }` is an ordinary import style, and matching
 * the callee text alone turned the whole check into a silent no-op for anyone
 * who used it.
 */
const localNamesFor = (sourceFile: SourceFile, imported: string): Set<string> => {
    const names = new Set<string>();

    for (const declaration of sourceFile.getImportDeclarations()) {
        for (const specifier of declaration.getNamedImports()) {
            if (!specifier.isTypeOnly() && specifier.getName() === imported) {
                names.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
            }
        }
    }

    return names;
};

/** Whether the file calls any of `names` as a plain function. */
const callsAnyOf = (sourceFile: SourceFile, names: ReadonlySet<string>): boolean => {
    let found = false;

    sourceFile.forEachDescendant((descendant, traversal) => {
        if (!TsNode.isCallExpression(descendant)) {
            return;
        }

        const callee = descendant.getExpression();

        if (TsNode.isIdentifier(callee) && names.has(callee.getText())) {
            found = true;
            traversal.stop();
        }
    });

    return found;
};

/** What the entry told us. `exports` is `undefined` when the file forwards names this scan cannot see. */
interface WorkerEntry {
    /** Whether the entry calls `defineApp(...)` itself — alias-aware. `false` for an entry that re-exports a worker built elsewhere. */
    composesApp: boolean;
    /** Runtime VALUE exports, or `undefined` when a bare `export *` makes the absence of a name prove nothing. */
    exports: Set<string> | undefined;
    /** The resolved entry path, for error messages. */
    path: string;
}

/**
 * Resolve, read and parse the worker entry once.
 *
 * Parsed with ts-morph rather than scanned with regexes. The scanner this
 * replaces had to stay advisory precisely because every export form it did not
 * know failed CLOSED — reporting a correctly-wired project as broken — and two
 * such forms (a prettier-wrapped clause, and the app builder's own
 * `export const { ShardDO } = app`) turned up in a single review pass. A real
 * parser knows them all, which is what lets the checks block.
 *
 * `undefined` means "cannot be decided" and every caller must report nothing.
 * Both routes there FAIL OPEN by design: no resolvable entry, and a file that
 * does not parse. ts-morph error-RECOVERS rather than throwing, and a recovered
 * parse silently drops statements — so a half-typed entry would otherwise report
 * every class as unexported and stop `lunora dev` mid-keystroke.
 */
const readWorkerEntry = (main: string | undefined, projectRoot: string, wranglerPath: string): WorkerEntry | undefined => {
    const path = resolveWorkerEntryPath(main, projectRoot, wranglerPath);

    if (path === undefined) {
        return undefined;
    }

    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }

    // `skipLoadingLibFiles` is load-bearing, not a micro-optimisation: asking for
    // the program pulls in the full `lib.d.ts` set otherwise, which measured
    // 571ms per call against 1.07ms without. Nothing here type-checks — the
    // diagnostics read is SYNTACTIC, which is per-file parse errors and
    // independent of the lib files.
    const project = new Project({
        compilerOptions: { allowJs: true },
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile(basename(path), source, { overwrite: true });

    if (project.getProgram().compilerObject.getSyntacticDiagnostics(sourceFile.compilerNode).length > 0) {
        return undefined;
    }

    const names = new Set<string>();
    const opaque = collectClauseExports(sourceFile, names);

    if (!opaque) {
        collectDeclarationExports(sourceFile, names);
    }

    return { composesApp: callsAnyOf(sourceFile, localNamesFor(sourceFile, APP_FACTORY)), exports: opaque ? undefined : names, path };
};

/** Directories a project's own sources never live in, skipped by {@link projectChainsVectors}. */
const NON_SOURCE_DIRECTORIES = new Set(["_generated", "build", "coverage", "dist", "node_modules", "out", "target"]);

/** Extensions worth reading when looking for a chained capability call. */
const SOURCE_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

/**
 * Ceiling on files read while looking for a `.vectors(...)` call. Past it the
 * scan gives up and answers "chained" — the fail-open direction, because the
 * caller BLOCKS a deploy on a negative.
 */
const MAX_SCANNED_FILES = 2000;

/** The literal a project's source must contain somewhere for the capability to be considered bound. */
const VECTORS_CHAIN = ".vectors(";

/**
 * Whether anything in the project's own sources chains `.vectors(...)`.
 *
 * Not limited to the entry file, and that is the whole point: the generated
 * builder returns `this`, so `configureVectors(app)` in a neighbouring module is
 * a supported wiring. A check that only read the entry would hard-error a
 * correct tree and tell the author to add a call they had already written.
 *
 * A literal text match, not an AST walk, because the direction of error matters:
 * anything that looks like the call CLEARS the check. A comment mentioning
 * `.vectors(` therefore also clears it — a false negative that leaves the app
 * exactly where it was before this check existed, which is the trade a blocking
 * gate should take.
 */
/** The source files directly in `directory`, and the subdirectories worth descending into. Unreadable directories read as empty. */
const readSourceDirectory = (directory: string): { files: string[]; subdirectories: string[] } => {
    const files: string[] = [];
    const subdirectories: string[] = [];
    let entries;

    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return { files, subdirectories };
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            // Dot-directories are tool state, never authored sources.
            if (!entry.name.startsWith(".") && !NON_SOURCE_DIRECTORIES.has(entry.name)) {
                subdirectories.push(join(directory, entry.name));
            }
        } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
            files.push(join(directory, entry.name));
        }
    }

    return { files, subdirectories };
};

/** Whether one file mentions the chained call. Unreadable files read as "no". */
const mentionsVectorsChain = (file: string): boolean => {
    try {
        return readFileSync(file, "utf8").includes(VECTORS_CHAIN);
    } catch {
        return false;
    }
};

const projectChainsVectors = (projectRoot: string): boolean => {
    const pending: string[] = [projectRoot];
    let budget = MAX_SCANNED_FILES;

    while (pending.length > 0) {
        const directory = pending.pop() as string;
        const { files, subdirectories } = readSourceDirectory(directory);

        pending.push(...subdirectories);

        for (const file of files) {
            budget -= 1;

            // Out of budget: answer "chained", the fail-open direction, because the
            // caller BLOCKS a deploy on a negative.
            if (budget < 0 || mentionsVectorsChain(file)) {
                return true;
            }
        }
    }

    return false;
};

export type { WorkerEntry };
export { projectChainsVectors, readWorkerEntry };
