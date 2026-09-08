/**
 * What a Lunora project says about itself, for the two wrangler validations that
 * have to read source rather than config. Both block a deploy, so both fail open.
 *
 * {@link readWorkerEntry} answers the one question only the ENTRY can answer —
 * which Durable Object / Workflow classes it exports — since wrangler binds
 * exactly what that file exports.
 *
 * {@link findUnchainedVectorsSite} answers the question the entry is the wrong
 * place to ask: does anything in the project bind the vector indexes its schema
 * declares. That is a project-wide fact, and reading it off the entry silently
 * disabled the check for every Vite-first layout.
 *
 * The checks that consume them stay next to the wrangler config types they also read.
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

/** What the entry told us. `exports` is `undefined` when the file forwards names this scan cannot see. */
interface WorkerEntry {
    /** Runtime VALUE exports, or `undefined` when a bare `export *` makes the absence of a name prove nothing. */
    exports: Set<string> | undefined;
    /** The resolved entry path, for error messages. */
    path: string;
}

/**
 * Parse one source in memory, or `undefined` when it does not parse.
 *
 * Parsed with ts-morph rather than scanned with regexes, because both callers
 * BLOCK a deploy on what they find. The scanner this replaces had to stay
 * advisory precisely because every form it did not know failed CLOSED —
 * reporting a correctly-wired project as broken — and two such forms (a
 * prettier-wrapped export clause, and the app builder's own
 * `export const { ShardDO } = app`) turned up in a single review pass.
 *
 * A file that does not parse FAILS OPEN: ts-morph error-RECOVERS rather than
 * throwing, and a recovered parse silently drops statements, so a half-typed
 * file would otherwise read as exporting nothing and composing nothing and stop
 * `lunora dev` mid-keystroke.
 *
 * The name is passed through because the extension selects the parser — `.tsx`
 * and `.jsx` mean JSX, `.cts`/`.mts` mean TypeScript.
 */
const parseSource = (name: string, source: string): SourceFile | undefined => {
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
    const sourceFile = project.createSourceFile(name, source, { overwrite: true });

    return project.getProgram().compilerObject.getSyntacticDiagnostics(sourceFile.compilerNode).length > 0 ? undefined : sourceFile;
};

/**
 * Resolve, read and parse the worker entry once.
 *
 * `undefined` means "cannot be decided" and every caller must report nothing.
 * Both routes there fail open: no resolvable entry, and a file that does not
 * parse ({@link parseSource}).
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

    const sourceFile = parseSource(basename(path), source);

    if (sourceFile === undefined) {
        return undefined;
    }

    const names = new Set<string>();
    const opaque = collectClauseExports(sourceFile, names);

    if (!opaque) {
        collectDeclarationExports(sourceFile, names);
    }

    return { exports: opaque ? undefined : names, path };
};

/** Directories a project's own sources never live in — generated or build output. */
const NON_SOURCE_DIRECTORIES = new Set(["_generated", "build", "coverage", "dist", "node_modules", "out", "target"]);

/**
 * Dot-directories that ARE authored sources. Everything else starting with a dot
 * is tool state (`.git`, `.wrangler`, `.svelte-kit`, `.vercel`, …) and skipping
 * the lot by prefix keeps that list from having to be maintained. `.server` /
 * `.client` are the React Router v7 / Remix convention for server-only and
 * client-only modules, so a `.vectors(...)` chain genuinely lives there — and a
 * missed chain HARD-ERRORS a correctly wired project.
 */
const SOURCE_DOT_DIRECTORIES = new Set([".client", ".server"]);

/**
 * Extensions worth reading. JS is included for the same reason `parseSource`
 * sets `allowJs`: a JS-authored project chains `.vectors(...)` in a `.mjs` like
 * any other, and missing that file would hard-error it.
 */
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/**
 * Ceiling on files read. Past it the scan gives up and reports nothing — the
 * fail-open direction, because the caller BLOCKS a deploy on what it finds.
 */
const MAX_SCANNED_FILES = 2000;

/** The literal a project's source must contain somewhere for the vector indexes to count as bound. */
const VECTORS_CHAIN = ".vectors(";

/** The generated app-composition factory, whatever a file chose to call it locally. */
const APP_FACTORY = "defineApp";

/**
 * The source files directly in `directory`, and the subdirectories worth
 * descending into. Unreadable directories read as empty.
 *
 * Deliberately not `infer-bindings`' `collectSourceFiles`, which walks two known
 * directories (`lunora/`, `src/`) and so can skip build output by name. This walk
 * starts at the project ROOT, where the framework output directories it must not
 * descend (`.svelte-kit`, `.next`, `.vercel`, …) are open-ended.
 */
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
            const skipped = (entry.name.startsWith(".") && !SOURCE_DOT_DIRECTORIES.has(entry.name)) || NON_SOURCE_DIRECTORIES.has(entry.name);

            if (!skipped) {
                subdirectories.push(join(directory, entry.name));
            }
        } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
            files.push(join(directory, entry.name));
        }
    }

    return { files, subdirectories };
};

/**
 * The local names `defineApp` is bound to in this file — plural because
 * `import { defineApp as createApp }` is an ordinary import style.
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

/**
 * Whether this file CALLS the imported `defineApp` — parsed, not text-matched.
 *
 * The precision is the point, because this is the half of the vectors check that
 * fails CLOSED: what it finds ARMS a deploy-blocking error. A substring match
 * armed it on Nuxt's unrelated `defineAppConfig`, on a doc comment naming
 * `defineApp()` (which two of this repo's own templates carry), and on a type-only
 * import — none of which a project can edit its way out of. Keying on the IMPORT
 * also means the generated `app.ts` that declares the factory cannot arm anything.
 *
 * The parse costs a `Project` per file, but only files whose text mentions the
 * factory at all are ever handed here, which in a real project is one or two.
 */
const composesApp = (file: string, source: string): boolean => {
    const sourceFile = parseSource(basename(file), source);

    return sourceFile !== undefined && callsAnyOf(sourceFile, localNamesFor(sourceFile, APP_FACTORY));
};

/** What one file contributes: it `binds` the vector indexes, `composes` the app, or neither. An unreadable file contributes nothing. */
const readMarker = (file: string): "binds" | "composes" | undefined => {
    let source: string;

    try {
        source = readFileSync(file, "utf8");
    } catch {
        return undefined;
    }

    if (source.includes(VECTORS_CHAIN)) {
        return "binds";
    }

    return source.includes(APP_FACTORY) && composesApp(file, source) ? "composes" : undefined;
};

/**
 * The file composing this project's app, when nothing in the project chains
 * `.vectors(...)` — otherwise `undefined`, meaning "nothing to report".
 *
 * Read from the whole project rather than from the worker entry, and that is the
 * whole point in both directions. The builder returns `this`, so
 * `configureVectors(app)` in a neighbouring module is a supported wiring, and a
 * check that only read the entry would hard-error a correct tree. And the entry
 * frequently is not where the app is composed at all: a class-A project points
 * `main` at a virtual specifier that names no file, and a class-B one at a
 * generated `src/worker.ts` that re-exports the app built in `src/server.ts`. Both
 * read as "composes nothing" from the entry alone, which turned this check off for
 * exactly the Vite-first projects it exists to protect.
 *
 * The two markers are deliberately asymmetric, because the caller BLOCKS a deploy.
 * `.vectors(` CLEARS the check and is a literal text match, so a comment mentioning
 * it clears too — a false negative that leaves the app exactly where it was before
 * this check existed, which is the trade a blocking gate should take. `defineApp`
 * ARMS it, so it is a parsed call ({@link composesApp}); a worker composed in
 * another package leaves no call here and is not judged.
 *
 * Both give-up routes — the file budget and an unparseable file — report nothing.
 */
const findUnchainedVectorsSite = (projectRoot: string): string | undefined => {
    const pending: string[] = [projectRoot];
    let scanned = 0;
    let site: string | undefined;

    while (pending.length > 0) {
        const directory = pending.pop() as string;
        const { files, subdirectories } = readSourceDirectory(directory);

        pending.push(...subdirectories);

        for (const file of files) {
            scanned += 1;

            if (scanned > MAX_SCANNED_FILES) {
                return undefined;
            }

            const marker = readMarker(file);

            if (marker === "binds") {
                return undefined;
            }

            if (marker === "composes") {
                site ??= file;
            }
        }
    }

    return site;
};

export type { WorkerEntry };
export { findUnchainedVectorsSite, readWorkerEntry };
