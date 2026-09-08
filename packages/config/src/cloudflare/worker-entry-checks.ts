/**
 * What a Lunora project says about itself, for the two wrangler validations that
 * have to read source rather than config. Both block a deploy, so both fail open.
 *
 * {@link readWorkerEntry} answers the one question only the ENTRY can answer —
 * which Durable Object / Workflow classes it exports — since wrangler binds
 * exactly what that file exports.
 *
 * {@link scanAppChains} answers the question the entry is the wrong place to ask:
 * does anything in the project chain the builder call a schema declaration needs
 * (`.vectors(...)`, `.global(...)`). That is a project-wide fact, and reading it
 * off the entry silently disabled the check for every Vite-first layout.
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

/** The generated schema's table builder. A `defineTable(...).global()` chain is the SCHEMA declaring a global table, not the app binding one. */
const TABLE_FACTORY = "defineTable";

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
 * The expression a member-call chain starts from: for
 * `defineTable({…}).global().index(…)` that is the `defineTable({…})` call.
 */
const chainRoot = (node: Node): Node => {
    let current = node;

    while (TsNode.isCallExpression(current) || TsNode.isPropertyAccessExpression(current)) {
        current = current.getExpression();
    }

    return current;
};

/**
 * Whether the chain `node` belongs to is rooted at a `defineTable(...)` call.
 *
 * `.global()` names two different builders — the app's (`.global({ d1 })`) and a
 * table's (`defineTable({…}).global()`, which is what MAKES the schema declare a
 * global table). Every project this check fires on therefore contains the table
 * form, so without this the schema would clear the gate on itself.
 *
 * Takes the file's LOCAL names for the factory rather than the bare string, the
 * same way {@link localNamesFor} feeds the `defineApp` probe: `import
 * { defineTable as table }` would otherwise leave the chain unrecognised, and a
 * table's own `.global()` would clear the app's gate.
 */
const rootsAtTableFactory = (node: Node, factoryNames: ReadonlySet<string>): boolean => {
    const root = chainRoot(node);

    return TsNode.isIdentifier(root) && factoryNames.has(root.getText());
};

/**
 * A builder method a schema declaration can require the app to chain. Closed on
 * purpose: {@link CHAIN_PREFILTERS} is keyed by it, so adding a capability
 * without its prefilter is a compile error rather than a gate that never fires.
 */
type CapabilityMethod = "global" | "hyperdriveGlobal" | "vectors";

/**
 * `.<method>(` with whitespace allowed on either side of the name — the text
 * prefilter deciding which files are worth a parse, deliberately LOOSER than the
 * parsed check that follows it. An exact `.vectors(` substring made the prefilter
 * stricter than the parser instead: the method never reached
 * {@link chainedMethods}, so a formatting variant reported a correctly wired
 * project as unchained and blocked its deploy.
 *
 * A fixed record rather than patterns built per method, so the key set is the
 * type and a capability nobody wrote a prefilter for is a compile error, not a
 * gate that silently never fires.
 *
 * Still narrower than the parser in one shape: `.global<T>({…})` skips the file
 * and hard-errors a project that chains it. Unreachable today — no generated
 * builder method takes type parameters — but that is the direction to widen if
 * one ever does.
 */
const CHAIN_PREFILTERS: Record<CapabilityMethod, RegExp> = {
    global: /\.\s*global\s*\(/u,
    hyperdriveGlobal: /\.\s*hyperdriveGlobal\s*\(/u,
    vectors: /\.\s*vectors\s*\(/u,
};

const isCapabilityMethod = (name: string): name is CapabilityMethod => Object.hasOwn(CHAIN_PREFILTERS, name);

/** Which of `methods` the file CALLS as `.<method>(...)` — parsed, so a comment or a string naming one is not a call site. */
const chainedMethods = (sourceFile: SourceFile, methods: ReadonlySet<CapabilityMethod>): Set<CapabilityMethod> => {
    const found = new Set<CapabilityMethod>();
    // The literal name UNION the file's local aliases: `localNamesFor` reads
    // named imports only, and a file that reaches the factory some other way must
    // not lose the un-aliased exclusion this guard has always made.
    const tableFactoryNames = new Set([TABLE_FACTORY, ...localNamesFor(sourceFile, TABLE_FACTORY)]);

    sourceFile.forEachDescendant((descendant) => {
        if (!TsNode.isCallExpression(descendant)) {
            return;
        }

        const callee = descendant.getExpression();

        if (!TsNode.isPropertyAccessExpression(callee) || rootsAtTableFactory(callee, tableFactoryNames)) {
            return;
        }

        const name = callee.getName();

        if (isCapabilityMethod(name) && methods.has(name)) {
            found.add(name);
        }
    });

    return found;
};

/**
 * What one file contributes: which of `methods` it chains, and whether it
 * composes the app. An unreadable file contributes nothing.
 *
 * Both markers are PARSED rather than text-matched, for opposite reasons.
 *
 * `defineApp` ARMS the deploy-blocking error, so a substring is too coarse: it
 * armed on Nuxt's unrelated `defineAppConfig`, on a doc comment naming
 * `defineApp()` (which two of this repo's own templates carry), and on a type-only
 * import — none of which a project can edit its way out of. Keying on the IMPORT
 * also means the generated `app.ts` that declares the factory cannot arm anything.
 *
 * A chained method CLEARS it, and a substring was too coarse there too, in the way
 * that matters most: the file that chains `.vectors()` is the likeliest file to
 * also carry a comment saying the chain is load-bearing, so deleting the call and
 * keeping the warning about deleting it disarmed the check — precisely the path
 * back to the outage it exists to prevent.
 *
 * A parse costs a `Project` per file, but only files whose text mentions a marker
 * at all get one, which in a real project is one or two. A file that mentions a
 * chain and does not parse counts as chaining it: unparseable is not evidence the
 * call is gone, and this half fails open.
 */
const readMarkers = (file: string, methods: ReadonlySet<CapabilityMethod>): { chained: Set<CapabilityMethod>; composes: boolean } | undefined => {
    let source: string;

    try {
        source = readFileSync(file, "utf8");
    } catch {
        return undefined;
    }

    const mentioned = new Set([...methods].filter((method) => CHAIN_PREFILTERS[method].test(source)));

    if (mentioned.size === 0 && !source.includes(APP_FACTORY)) {
        return undefined;
    }

    const sourceFile = parseSource(basename(file), source);

    if (sourceFile === undefined) {
        return { chained: mentioned, composes: false };
    }

    return { chained: chainedMethods(sourceFile, mentioned), composes: callsAnyOf(sourceFile, localNamesFor(sourceFile, APP_FACTORY)) };
};

/** Where the app is composed, and which of the requested builder methods the project chains anywhere. */
interface ChainScan {
    chained: ReadonlySet<CapabilityMethod>;
    site: string;
}

/**
 * Scan the project for the builder methods a schema declaration requires the app
 * to chain. `undefined` means "nothing to report".
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
 * Both markers are parsed calls ({@link readMarkers}) — a comment or a string
 * naming either one decides nothing. A worker composed in another package leaves
 * no `defineApp` call here and is not judged.
 *
 * Both give-up routes — the file budget and an unparseable file — report nothing.
 *
 * Stops as soon as the answer is settled — the app is composed and every requested
 * method is chained. Nothing read later can change it (`site` keeps the FIRST
 * composing file, `chained` only grows), and a correctly wired project is the
 * common case, so without this every `verify` / `doctor` / `build` / `deploy` read
 * and scanned the whole tree to reach a conclusion it already had.
 */
const scanAppChains = (projectRoot: string, methods: ReadonlySet<CapabilityMethod>): ChainScan | undefined => {
    const pending: string[] = [projectRoot];
    const chained = new Set<CapabilityMethod>();
    let scanned = 0;
    let site: string | undefined;

    /** Fold one file into the running answer; `false` means the budget is spent. */
    const take = (file: string): boolean => {
        scanned += 1;

        if (scanned > MAX_SCANNED_FILES) {
            return false;
        }

        const markers = readMarkers(file, methods);

        for (const method of markers?.chained ?? []) {
            chained.add(method);
        }

        if (markers?.composes) {
            site ??= file;
        }

        return true;
    };

    while (pending.length > 0) {
        const directory = pending.pop() as string;
        const { files, subdirectories } = readSourceDirectory(directory);

        pending.push(...subdirectories);

        for (const file of files) {
            if (!take(file)) {
                return undefined;
            }

            if (site !== undefined && chained.size === methods.size) {
                return { chained, site };
            }
        }
    }

    return site === undefined ? undefined : { chained, site };
};

export type { CapabilityMethod, WorkerEntry };
export { readWorkerEntry, scanAppChains };
