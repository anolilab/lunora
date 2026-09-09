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

import {
    COMPOSED_ENTRY_DURABLE_OBJECTS,
    COMPOSED_WORKER_ENTRY,
    GENERATED_CLASS_MODULES,
    GENERATED_DIRECTORY,
    isGeneratedOutput,
    LUNORA_WORKER_VIRTUAL_ID,
    NON_SOURCE_DIRECTORIES,
    SOURCE_DOT_DIRECTORIES,
    WORKER_ENTRY_FALLBACKS,
} from "../infer-bindings";
import join from "../path";

/** Source extensions, in the order a relative specifier resolves them. */
const SOURCE_EXTENSION_ORDER = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * Extensions an AUTHORED Lunora entry carries. JS is absent on purpose: a
 * class-B `main` can name the framework adapter's BUILD OUTPUT
 * (`.svelte-kit/cloudflare/_worker.js`), which exports only the SSR fetch
 * handler, so every declared class reads as unexported there — and this finding
 * blocks a deploy. A JS `main` is decided by LOCATION instead
 * ({@link isGeneratedOutput}), because a hand-written `src/worker.js` is an
 * ordinary Lunora entry and diverting off it reported a correct project broken.
 */
const WORKER_ENTRY_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(SOURCE_EXTENSION_ORDER);

/** Extensions a bundler-emitted worker carries. Read only when the path says it is authored. */
const WORKER_ENTRY_JS_EXTENSIONS: ReadonlySet<string> = new Set([".cjs", ".js", ".mjs"]);

/**
 * The name a `default` export binds. No class is called `default`, so carrying
 * it in the export set cannot satisfy a `class_name` — it only answers "is this
 * file a module worker?" ({@link readWorkerEntry}).
 */
const DEFAULT_EXPORT = "default";

/**
 * The TypeScript extensions a JS specifier names. `@lunora/codegen` deliberately
 * writes `.js` into the code it GENERATES, and its own emitted instruction is
 * `export * from "./lunora/_generated/workflows.js"` — that specifier names a
 * `.ts` file, so refusing to map it would leave the commonest star re-export in
 * a Lunora entry unresolvable, and an unresolvable star turns this check off.
 */
const JS_SPECIFIER_EXTENSIONS: Record<string, ReadonlyArray<string>> = {
    ".cjs": [".cts"],
    ".js": [".ts", ".tsx"],
    ".mjs": [".mts"],
};

/**
 * Ceiling on modules FOLLOWED out of one entry through star re-exports. Past it
 * the read gives up and the module reads as opaque — the fail-open direction,
 * because the caller BLOCKS a deploy on what it finds.
 *
 * A runaway guard, not a budget to spend: it was 24, which a barrel-heavy tree
 * can reach, and reaching it turns the check off with no signal. The cost per
 * module is one `parseSource` (~1ms — {@link parseSource} skips the lib files
 * for exactly this reason), and the entry's re-export graph in a real project is
 * a handful of files, so the ceiling sits far above anything authored rather
 * than close enough to trip.
 *
 * The root does not count against it: an entry that declares its classes inline
 * should not lose the check because something it stars is wide.
 */
const MAX_FOLLOWED_MODULES = 250;

/**
 * Where the worker entry is, and how confident we are that it IS the entry.
 *
 * `"declared"` — `wrangler.main` (or the class-B composed `src/worker.ts`) named
 * this file. Trusted: the user said so.
 *
 * `"probed"` — nothing named a readable entry, so a conventional location was
 * guessed. A guess must not be trusted the way a declaration is; see
 * {@link readWorkerEntry}.
 *
 * `"absent"` — `main` names a source file that is not there. Nothing to read,
 * and the caller reports it (the wrangler validator raises a warning) rather
 * than guessing a different file: diverting the cross-check onto whichever
 * fallback happened to exist hard-errored trees that were one keystroke from
 * correct.
 *
 * `"composed"` — the class-A virtual specifier, which names no file at all. Its
 * exports come from the generator ({@link readComposedEntry}).
 */
type WorkerEntryLocation = { origin: "absent" | "declared" | "probed"; path: string } | { origin: "composed" } | undefined;

/**
 * Locate the worker entry the way `lunora deploy` bundles it: the class-B
 * composed entry when present (it is passed to wrangler as the positional
 * script, overriding `main`), else `wrangler.main` relative to the config file,
 * else the conventional fallbacks.
 *
 * Two routes reach `"probed"`, and both are layouts where nothing names the
 * authored entry: a `main` pointing at the framework adapter's build output (the
 * entry that wraps it is a sibling source file), and no `main` at all, where
 * `@cloudflare/vite-plugin` supplies it.
 *
 * Everything else keeps its own arm so a guess is never mistaken for a
 * declaration. Probing for ANY unreadable `main` resolved a hand-written
 * `src/worker.js` — a supported entry, since {@link parseSource} sets `allowJs` —
 * to an unrelated `src/index.ts` and called its exported `ShardDO` missing.
 */
const locateWorkerEntry = (main: string | undefined, projectRoot: string, wranglerPath: string): WorkerEntryLocation => {
    const composed = join(projectRoot, COMPOSED_WORKER_ENTRY);

    if (existsSync(composed)) {
        return { origin: "declared", path: composed };
    }

    if (main === LUNORA_WORKER_VIRTUAL_ID) {
        return { origin: "composed" };
    }

    const probe = (): WorkerEntryLocation => {
        const found = WORKER_ENTRY_FALLBACKS.map((fallback) => join(projectRoot, fallback)).find((candidate) => existsSync(candidate));

        return found === undefined ? undefined : { origin: "probed", path: found };
    };

    if (typeof main !== "string" || main.length === 0) {
        return probe();
    }

    // Build output is never the authored entry, whether or not it has been built
    // yet — so the authored entry is elsewhere and worth probing for.
    if (isGeneratedOutput(main)) {
        return probe();
    }

    const resolved = join(dirname(wranglerPath), main);
    const extension = extname(resolved);

    if (!WORKER_ENTRY_SOURCE_EXTENSIONS.has(extension) && !WORKER_ENTRY_JS_EXTENSIONS.has(extension)) {
        return undefined;
    }

    return existsSync(resolved) ? { origin: "declared", path: resolved } : { origin: "absent", path: resolved };
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

/**
 * The names an `export { … }` / `export … from "…"` clause binds as values, plus
 * the module specifier of every bare `export * from "…"` — the names those
 * forward live in another module, so the caller has to go read it.
 */
const collectClauseExports = (sourceFile: SourceFile, names: Set<string>): string[] => {
    const stars: string[] = [];

    for (const declaration of sourceFile.getExportDeclarations()) {
        if (declaration.isTypeOnly()) {
            continue;
        }

        // Only a STAR re-export forwards names, and `isNamespaceExport()` is the
        // one predicate that identifies it. Testing "no named exports" instead
        // also caught `export {}` — which binds nothing and is a routine way to
        // mark a file as a module — and one of those anywhere in the entry
        // silently turned this whole check off. That is worse than the bug it
        // exists to catch, because it reads as a pass.
        if (declaration.isNamespaceExport()) {
            const namespaceExport = declaration.getNamespaceExport();

            if (namespaceExport === undefined) {
                // `export *` cannot be written without `from`, so the fallback is
                // unreachable — and it fails open if it ever is not: `""` is not
                // a relative specifier, so `resolveRelativeModule` rejects it and
                // the module reads as opaque.
                stars.push(declaration.getModuleSpecifierValue() ?? "");
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

    return stars;
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
        // export never satisfies a `class_name` — but the fact that the module
        // HAS one is what tells `readWorkerEntry` a probed file is a worker.
        if (declaration.getExportKeyword() === undefined) {
            continue;
        }

        const name = declaration.isDefaultExport() ? DEFAULT_EXPORT : declaration.getName();

        if (name !== undefined) {
            names.add(name);
        }
    }

    // `export default app` / `export = app`: neither is a declaration, and
    // `export *` does not forward `default`, so a module worker always writes one
    // of these (or `export default class`, above) in the entry itself.
    if (sourceFile.getExportAssignments().length > 0) {
        names.add(DEFAULT_EXPORT);
    }
};

/** What the entry told us. `exports` is `undefined` when the entry forwards names this scan cannot see. */
interface WorkerEntry {
    /** Runtime VALUE exports, or `undefined` when an unresolvable `export *` makes the absence of a name prove nothing. */
    exports: Set<string> | undefined;

    /**
     * `"composed"` for the class-A entry `@lunora/vite` generates. The remedy
     * differs there and nowhere else: there is no file to add a re-export to,
     * so telling the user to add one is unactionable advice.
     */
    kind: "authored" | "composed";
    /** The resolved entry path (or the virtual specifier), for error messages. */
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
 * The file a relative `export * from "…"` specifier names, or `undefined` for
 * anything this scan must not judge.
 *
 * Only RELATIVE specifiers resolve. A bare one (`@lunora/scheduler`) or a
 * tsconfig/framework alias (`~/durable-objects`, `#lunora/app`) names a module
 * whose location this check does not know, and guessing wrong would report a
 * correctly-wired project as broken — so those stay unresolvable, which reads
 * the entry as opaque and reports nothing.
 */
const resolveRelativeModule = (fromFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return undefined;
    }

    const base = join(dirname(fromFile), specifier);
    const extension = extname(base);
    // Whether the trailing dot-suffix is an extension this resolver KNOWS. A
    // `./do.server` (the React Router / Remix convention this file already
    // honours elsewhere) carries a dot suffix that is part of the FILENAME, and
    // stripping it blindly both hid the real `do.server.ts` and probed a
    // `do/index.ts` sibling in its place — a wrong export set either way.
    const stripped = WORKER_ENTRY_SOURCE_EXTENSIONS.has(extension) || JS_SPECIFIER_EXTENSIONS[extension] !== undefined;
    const stem = stripped ? base.slice(0, -extension.length) : base;
    const candidates = [
        ...(WORKER_ENTRY_SOURCE_EXTENSIONS.has(extension) ? [base] : []),
        ...(JS_SPECIFIER_EXTENSIONS[extension] ?? []).map((candidate) => `${stem}${candidate}`),
        // Extensionless (`./objects`) and unrecognised-suffix (`./do.server`)
        // specifiers name the file itself.
        ...(stripped ? [] : SOURCE_EXTENSION_ORDER.map((candidate) => `${base}${candidate}`)),
        // A directory, probed only when nothing was stripped off a real name.
        ...(stripped || extension.length === 0 ? SOURCE_EXTENSION_ORDER.map((candidate) => join(stem, `index${candidate}`)) : []),
    ];

    return candidates.find((candidate) => existsSync(candidate));
};

/**
 * Every runtime VALUE name a module exports, following bare `export * from "…"`
 * into the modules it forwards from. `undefined` means "cannot be decided".
 *
 * Following the star is what makes this check apply to a normal entry at all: a
 * bare star reads as opaque otherwise, and it is the commonest shape there is —
 * a barrel (`export * from "./durable-objects"`), and the line `@lunora/codegen`
 * itself tells the entry to write (`export * from
 * "./lunora/_generated/workflows.js"`).
 *
 * A cycle (`a` stars `b` stars `a`) is legal and forwards no new names, so the
 * `seen` set both terminates it and holds the work to one parse per module;
 * {@link MAX_FOLLOWED_MODULES} is the runaway guard. Both give-up routes, plus
 * an unreadable file, an unparseable one and an unresolvable specifier, report
 * `undefined` — the caller BLOCKS a deploy on what this returns.
 *
 * A flat worklist rather than recursion, matching {@link scanAppChains} below.
 * Every name lands in one set, so there are no partial per-module results to
 * reason about.
 */
const readModuleExports = (entryPath: string): Set<string> | undefined => {
    const names = new Set<string>();
    const seen = new Set([entryPath]);
    const pending = [entryPath];

    while (pending.length > 0) {
        // `- 1` so the ceiling counts FOLLOWED modules, not the entry itself.
        if (seen.size - 1 > MAX_FOLLOWED_MODULES) {
            return undefined;
        }

        const path = pending.pop() as string;
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

        const stars = collectClauseExports(sourceFile, names);

        collectDeclarationExports(sourceFile, names);

        for (const specifier of stars) {
            const resolved = resolveRelativeModule(path, specifier);

            if (resolved === undefined) {
                return undefined;
            }

            if (!seen.has(resolved)) {
                seen.add(resolved);
                pending.push(resolved);
            }
        }
    }

    return names;
};

/**
 * The exports of the class-A composed entry, which has no file to read.
 *
 * `@lunora/vite` generates it, and it emits exactly one class of its own
 * (`export const ShardDO = app.ShardDO`, from {@link COMPOSED_ENTRY_DURABLE_OBJECTS})
 * plus a star re-export of each {@link GENERATED_CLASS_MODULES} file the project
 * has. So the export set is knowable without a bundle — and class-A is the one
 * shape where the user CANNOT add a re-export, so a `class_name` outside that
 * set is a deploy wrangler will always refuse.
 *
 * A project with no `_generated/` directory has not run codegen yet, and the
 * composed entry is then not a fact about anything — reported as opaque rather
 * than as an entry exporting only `ShardDO`.
 */
const readComposedEntry = (projectRoot: string, schemaDirectory: string): WorkerEntry => {
    const opaque: WorkerEntry = { exports: undefined, kind: "composed", path: LUNORA_WORKER_VIRTUAL_ID };
    const generatedDirectory = join(projectRoot, schemaDirectory, GENERATED_DIRECTORY);

    if (!existsSync(generatedDirectory)) {
        return opaque;
    }

    const names = new Set<string>(COMPOSED_ENTRY_DURABLE_OBJECTS);

    for (const module of GENERATED_CLASS_MODULES) {
        const modulePath = join(generatedDirectory, `${module}.ts`);

        if (!existsSync(modulePath)) {
            continue;
        }

        const forwarded = readModuleExports(modulePath);

        if (forwarded === undefined) {
            return opaque;
        }

        for (const name of forwarded) {
            names.add(name);
        }
    }

    return { exports: names, kind: "composed", path: LUNORA_WORKER_VIRTUAL_ID };
};

/**
 * Read the exports of a located worker entry.
 *
 * `undefined` means "cannot be decided" and every caller must report nothing.
 * Every route there fails open: no located entry, a `main` that names a file
 * which is not there, one that does not parse ({@link parseSource}), a star
 * re-export that cannot be followed ({@link readModuleExports}), and a
 * `"probed"` file that does not look like a worker at all.
 *
 * That last guard is what makes probing safe. A Cloudflare module worker MUST
 * export `default`, and a guessed location can easily be something else —
 * `src/index.ts` is the CLIENT entry in a class-A app and an ordinary barrel in
 * plenty of others. Reading one of those as the worker reported its declared
 * classes missing and blocked the deploy. A `"declared"` entry is trusted
 * without the guard: the user named that file, so "it exports no `default`" is a
 * different bug and not this check's to guess at.
 */
const readWorkerEntry = (location: WorkerEntryLocation, projectRoot: string, schemaDirectory: string): WorkerEntry | undefined => {
    if (location === undefined || location.origin === "absent") {
        return undefined;
    }

    if (location.origin === "composed") {
        return readComposedEntry(projectRoot, schemaDirectory);
    }

    const exports = readModuleExports(location.path);

    if (location.origin === "probed" && exports !== undefined && !exports.has(DEFAULT_EXPORT)) {
        return undefined;
    }

    return { exports, kind: "authored", path: location.path };
};

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

export type { CapabilityMethod, WorkerEntry, WorkerEntryLocation };
export { locateWorkerEntry, readWorkerEntry, scanAppChains };
