/**
 * Which worker entry a project deploys, and which classes it exports as runtime
 * values — the half of binding inference that reads the entry rather than the
 * app's imports. Shared with the wrangler validator's exported-class check.
 */
import { existsSync, readFileSync } from "node:fs";

import { parse as lexModule } from "es-module-lexer";

import { readWranglerJsonc, WRANGLER_FILES } from "./cloudflare/wrangler-path";
import { escapeRegExp } from "./dev-variables-format";
import join from "./path";

/** Where `@lunora/codegen` writes, relative to the schema directory. */
const GENERATED_DIRECTORY = "_generated";

interface DurableObjectSpec {
    binding: string;
    className: string;
}

/**
 * Worker-entry candidates probed when `wrangler.main` names no readable source
 * file — absent, or pointing at a framework adapter's build output.
 *
 * `src/server.ts` leads because it is where the class-B templates (astro,
 * solid-v2, standalone) and `@lunora/astro`'s `serverEntry` compose, and its
 * absence disabled the declared-class export cross-check for exactly those
 * layouts. Same list, same order as `lunora registry`'s reconcile probe, which
 * had it — the two had drifted.
 *
 * A probe result is a GUESS, and callers weigh it accordingly: the validator
 * only trusts one that exports `default` (`worker-entry-checks`), and binding
 * inference reads it to decide what to provision, so a wrong guess here is
 * silent at deploy time.
 */
const WORKER_ENTRY_FALLBACKS = ["src/server.ts", "src/server/index.ts", "src/server/index.tsx", "src/index.ts", "src/worker.ts"] as const;

/** Directories a project's own sources never live in — generated or build output. */
const NON_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set(["build", "coverage", "dist", GENERATED_DIRECTORY, "node_modules", "out", "target"]);

/**
 * Dot-directories that ARE authored sources. Everything else starting with a dot
 * is tool state (`.git`, `.wrangler`, `.svelte-kit`, `.vercel`, …) and skipping
 * the lot by prefix keeps that list from having to be maintained. `.server` /
 * `.client` are the React Router v7 / Remix convention for server-only and
 * client-only modules, so a `.vectors(...)` chain genuinely lives there — and a
 * missed chain HARD-ERRORS a correctly wired project.
 */
const SOURCE_DOT_DIRECTORIES: ReadonlySet<string> = new Set([".client", ".server"]);

/** Either separator, so a Windows-style `main` splits the same way. */
const PATH_SEPARATOR = /[/\\]/u;

/**
 * A relative path's segments with `.` dropped and `..` applied — the resolution
 * `node:path` would do, but separator-agnostic so a Windows-style `main` behaves
 * the same on a posix host (`node:path.normalize` treats `\` as an ordinary
 * character there). A leading `..` that escapes the root is kept: it is not a
 * directory name, and no caller treats it as one.
 */
const normalizeSegments = (relativePath: string): string[] => {
    const segments: string[] = [];

    for (const segment of relativePath.split(PATH_SEPARATOR)) {
        if (segment === "" || segment === ".") {
            continue;
        }

        if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
            segments.pop();
        } else {
            segments.push(segment);
        }
    }

    return segments;
};

/**
 * Whether `main` points INTO a build-output location — the same
 * {@link NON_SOURCE_DIRECTORIES} the project scan skips, plus every
 * dot-directory by prefix (`.svelte-kit`, `.output`, `.vercel`, `.next`) minus
 * the two that ARE authored sources.
 *
 * The gate is by location because it cannot be by extension: a bundled
 * `_worker.js` exports only the SSR handler, but a hand-written `src/worker.js`
 * is an ordinary entry, and both are `.js`.
 */
const isGeneratedOutput = (relativeMain: string): boolean =>
    // Normalized FIRST, with stack semantics, because a traversal cancels the
    // segment before it: `dist/../src/server.ts` names an authored entry, and
    // merely dropping the `..` left `dist` behind and classified it as build
    // output. Reading a declared entry as build output discarded it — the
    // validator then blocked the deploy naming whichever fallback it probed, and
    // inference provisioned off that file, not even SHARD.
    normalizeSegments(relativeMain)
        .slice(0, -1)
        .some((segment) => NON_SOURCE_DIRECTORIES.has(segment) || (segment.startsWith(".") && !SOURCE_DOT_DIRECTORIES.has(segment)));

/**
 * Canonical Durable Object class → binding name. wrangler requires the worker
 * to export a class of this exact name, so detection keys on the class name.
 */
const DURABLE_OBJECT_BINDINGS = {
    SchedulerDO: "SCHEDULER",
    SessionDO: "SESSION",
    ShardDO: "SHARD",
} as const;

type DurableObjectClass = keyof typeof DURABLE_OBJECT_BINDINGS;

const DURABLE_OBJECT_CLASSES = Object.keys(DURABLE_OBJECT_BINDINGS) as DurableObjectClass[];

/** Whether `className` is one of Lunora's own Durable Object classes rather than a project's generated or hand-written one. */
const isFrameworkDurableObject = (className: string): className is DurableObjectClass => Object.hasOwn(DURABLE_OBJECT_BINDINGS, className);

/* eslint-disable no-secrets/no-secrets -- false positive: `frameworkComposePlugin` is a function name in prose, not a credential */

/**
 * The virtual module id `@lunora/vite`'s `frameworkComposePlugin` resolves to a
 * COMPOSED class-A worker entry. Every class-A template sets `wrangler.main` to
 * it and ships no entry file at all, so an fs probe can never find one.
 *
 * Duplicated (not imported) from `@lunora/vite`: `@lunora/vite` depends on
 * `@lunora/config`, so importing back would be a cycle. The literal is the
 * public contract a template's `wrangler.jsonc` writes by hand anyway.
 */
const LUNORA_WORKER_VIRTUAL_ID = "virtual:lunora/worker";

/* eslint-enable no-secrets/no-secrets -- re-enable after the LUNORA_WORKER_VIRTUAL_ID doc block */

/**
 * What the project's `wrangler.main` (or the fallback probe) resolves to.
 *
 * `composed` is the class-A case: there is no file to lex, and treating that as
 * "no worker entry" is what made every container/workflow/agent read
 * `exported: false` and get filtered out of reconcile — the app then deployed
 * green and failed at runtime on a missing binding. The composed entry's exports
 * are known statically instead (see {@link COMPOSED_ENTRY_DURABLE_OBJECTS} and
 * `@lunora/vite`'s `GENERATED_CLASS_MODULES`).
 */
interface WorkerEntry {
    /** `true` when `wrangler.main` is `virtual:lunora/worker` — `@lunora/vite` composes the entry. */
    composed: boolean;
    /** Absolute path to a hand-written entry file, or `undefined` for the composed entry / no entry at all. */
    path?: string;
}

/**
 * The Durable Object classes the composed class-A entry exports. It emits
 * exactly one — `export const ShardDO = app.ShardDO` off the generated
 * `defineApp()` builder — plus star
 * re-exports of the generated container/workflow/agent modules (handled by
 * {@link detectClassExports}). `SessionDO` is NOT composed in, so it stays
 * unprovisioned, which is honest: binding it would name a class the bundle does
 * not export and `wrangler deploy` would reject it.
 *
 * `SchedulerDO` used to be in that sentence. It now reaches the entry through
 * the generated `scheduler` module ({@link GENERATED_CLASS_MODULES}) whenever the
 * app has a scheduler, so `inferLunoraBindings` adds it to this list on that
 * condition — see the call site.
 */
const COMPOSED_ENTRY_DURABLE_OBJECTS: DurableObjectClass[] = ["ShardDO"];

/**
 * The `_generated/` modules that hold a generated Durable Object / Workflow
 * class — one per class kind a project can declare. wrangler validates every
 * `class_name` against the worker's exports, so this is the set a worker entry
 * re-exports (and the set the composed class-A entry star-re-exports for the
 * kinds the project has).
 *
 * Owned here because four places need it and they must not drift:
 * `@lunora/vite` emits one star re-export per entry, the wrangler validator
 * DECIDES the composed entry's exports from it, `reconcile-bindings` types its
 * export-gap `module` field on it, and this module's own `detectClassExports`
 * probes the same names.
 *
 * `scheduler` carries no `define*` declarations of its own — codegen writes it
 * off `hasScheduler` purely so the composed class-A entry has a `SchedulerDO`
 * to forward. Its presence is therefore the ONLY signal the plugin and the
 * validator need, and it is the same signal that decides whether the builder
 * has a `.scheduler()` method at all. `@lunora/vite` depends on `@lunora/config`, so config
 * owning it is the direction the dependency graph allows.
 */
const GENERATED_CLASS_MODULES = ["agents", "containers", "scheduler", "workflows"] as const;

/** One {@link GENERATED_CLASS_MODULES} entry. */
type GeneratedClassModule = (typeof GENERATED_CLASS_MODULES)[number];

/**
 * The class-B composed entry. `lunora deploy` passes this file to wrangler as
 * the positional script whenever it exists, overriding `wrangler.main` — so it
 * is what actually gets bundled and what wrangler checks its DO/Workflow
 * bindings against. `main` in a class-B project names the framework adapter's
 * build output (`.svelte-kit/cloudflare/_worker.js`, `dist/_worker.js`), which
 * exists after `vite build` and exports only the SSR fetch handler. Lexing that
 * instead read every declared class as unexported: nothing provisioned, plus a
 * "add `export * from …`" warning the user cannot silence.
 *
 * Exported, not documented-as-duplicated: the CLI's `resolveComposedWorkerEntry`
 * imports this constant, so the deploy's positional entry and the file this
 * module lexes for exported classes cannot drift apart.
 */
const COMPOSED_WORKER_ENTRY = "src/worker.ts";

/** Read the worker entry from `wrangler.main`, or probe known fallbacks. */
const resolveWorkerEntry = (projectRoot: string): WorkerEntry => {
    for (const candidate of WRANGLER_FILES) {
        const wranglerPath = join(projectRoot, candidate);

        if (!existsSync(wranglerPath)) {
            continue;
        }

        const { parsed } = readWranglerJsonc<{ main?: string }>(wranglerPath);
        const main = parsed?.main;

        // The class-A composed entry: no file exists (nor ever will), and the
        // fallback probe below must NOT run — `src/index.ts` in a class-A app is
        // the client entry, not the worker, so probing it would read the wrong
        // file's exports.
        if (main === LUNORA_WORKER_VIRTUAL_ID) {
            return { composed: true };
        }

        const composedPath = join(projectRoot, COMPOSED_WORKER_ENTRY);

        if (existsSync(composedPath)) {
            return { composed: false, path: composedPath };
        }

        // `!isGeneratedOutput` is the same gate `locateWorkerEntry` applies, and it
        // has to be here too: a BUILT adapter artifact exists, so without it this
        // returned `dist/_worker.js` and lexed a bundle that exports only the SSR
        // handler. Every class then read as unexported and reconcile provisioned
        // NOTHING — not even SHARD — which is a green deploy that fails at runtime
        // on a missing binding, exactly what `COMPOSED_WORKER_ENTRY` documents.
        if (typeof main === "string" && !isGeneratedOutput(main) && existsSync(join(projectRoot, main))) {
            return { composed: false, path: join(projectRoot, main) };
        }

        break;
    }

    for (const fallback of WORKER_ENTRY_FALLBACKS) {
        const fullPath = join(projectRoot, fallback);

        if (existsSync(fullPath)) {
            return { composed: false, path: fullPath };
        }
    }

    return { composed: false };
};

/** The inline `type` qualifier immediately before an export entry's local name (`export { type Foo }`). Module-scoped so it compiles once, not per export entry. */
const INLINE_TYPE_QUALIFIER = /(?:^|[\s,{])type$/u;

/**
 * PRIMARY (lexer-based, per-entry) type-only-export detector. Whether a lexer
 * export entry is the inline `export { type Foo }` (or `export { type Foo as Bar }`)
 * form — the one type-only export shape `es-module-lexer` still lists (it already
 * omits the `export type Foo` declaration and the separate `export type { Foo }`
 * form from its export list). The `type` qualifier sits immediately before the
 * entry's LOCAL name, so we test the source right before `entry.ls` (falling back
 * to `entry.s` when there is no `as` rename). Deciding this PER ENTRY is what keeps
 * a real value export from being suppressed by an unrelated type-only export
 * elsewhere in the entry file — or, as the DO classes used to suffer, by a
 * type-only IMPORT of the same name somewhere else in the entry.
 *
 * The imprecise whole-file counterpart used only when the lexer can't parse the
 * file is {@link isTypeOnlyExportRegexFallback}.
 */
const isTypeOnlyExportEntry = (code: string, entry: { readonly ls: number; readonly s: number }): boolean => {
    const localStart = entry.ls >= 0 ? entry.ls : entry.s;

    return INLINE_TYPE_QUALIFIER.test(code.slice(0, localStart).trimEnd());
};

/**
 * FALLBACK (whole-file regex) type-only-export detector — the imprecise
 * counterpart to {@link isTypeOnlyExportEntry}, used ONLY when `es-module-lexer`
 * cannot parse a mid-edit file. Matches a *type-only* export of `className` —
 * `export type Foo`, the separate `export type { … Foo … }`, or the inline
 * `export { type Foo }`. Every arm is anchored on `export`, so a type-only
 * IMPORT of the same name is not mistaken for one; the class name is escaped and
 * every pattern carries the `u` flag. The primary (lexer) path decides
 * type-only-ness per export entry instead — this blind whole-file sweep cannot tell
 * which `export` a repeated name came from, so a value + separate type export of
 * the same name still (conservatively) reads type-only here; acceptable for the
 * rare unparseable-file fallback.
 */
const isTypeOnlyExportRegexFallback = (code: string, className: string): boolean => {
    const name = escapeRegExp(className);

    return (
        new RegExp(String.raw`\bexport\s+type\s+${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s+type\s*\{[^}]*\b${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s+\{[^}]*\btype\s+${name}\b`, "u").test(code)
    );
};

/* eslint-disable no-secrets/no-secrets -- false positive: the two detector names in prose below, not credentials */

/**
 * The Durable Object classes the worker entry exports. Uses `es-module-lexer`'s
 * export list so every form is covered (`export const ShardDO`, `export {
 * SchedulerDO } from "./do"`, aliases). These are the only DO classes safe to
 * bind, since wrangler validates that a binding's `class_name` is exported.
 *
 * Type-only-ness is decided by the same two detectors the generated classes use
 * ({@link isTypeOnlyExportEntry} per lexer entry, {@link isTypeOnlyExportRegexFallback}
 * when the file will not parse). The core classes used to get a weaker,
 * unanchored whole-file `\btype\s+ShardDO\b` instead, which an ordinary
 * `import { type ShardDO, createShardDO }` satisfied — so reconcile refused the
 * SHARD binding and `wrangler-validator` then failed the deploy telling the user
 * their dev server auto-reconciles this on startup.
 */
/* eslint-enable no-secrets/no-secrets -- re-enable after the detector doc block */
const detectExportedDurableObjects = (entryPath: string): DurableObjectSpec[] => {
    const code = readFileSync(entryPath, "utf8");
    let exportedNames: Set<string>;

    // A candidate counts only when it is exported as a runtime VALUE — an
    // inline `export { type ShardDO }` lists the name but compiles away, and
    // binding it would make `wrangler deploy` fail on the missing class.
    try {
        const [, exports] = lexModule(code);

        exportedNames = new Set(exports.filter((entry) => !isTypeOnlyExportEntry(code, entry)).map((entry) => entry.n));
    } catch {
        exportedNames = new Set(
            DURABLE_OBJECT_CLASSES.filter(
                (className) => new RegExp(String.raw`\bexport\b[^\n;]*\b${className}\b`, "u").test(code) && !isTypeOnlyExportRegexFallback(code, className),
            ),
        );
    }

    return DURABLE_OBJECT_CLASSES.filter((className) => exportedNames.has(className)).map((className) => {
        return {
            binding: DURABLE_OBJECT_BINDINGS[className],
            className,
        };
    });
};

/** A discovered definition whose generated class may or may not be exported by the worker entry. */
interface ClassExportable {
    className: string;
}

/**
 * Whether the worker entry exports each definition's generated class: a named
 * export of the class (covered by `es-module-lexer`'s export list) or the
 * conventional `export * from "./lunora/_generated/<generatedModule>"` star
 * re-export — the way a worker entry re-exports every generated class of one
 * kind at once. `es-module-lexer` lists the module request but not the names a
 * star re-export forwards, so the path itself is the signal that every class
 * from that module is exported.
 *
 * One generic replaces what were three near-identical copies
 * (`detectContainerExports`/`detectWorkflowExports`/`detectAgentExports`,
 * differing only in the star-reexport module name and the IR type) — exports
 * are the only safe provisioning signal for all three kinds, since wrangler
 * validates `class_name` against the worker's exports at deploy. Mirrors the
 * same lexer-then-regex-fallback shape as `detectExportedDurableObjects`.
 */
const detectClassExports = <Definition extends ClassExportable>(
    entry: WorkerEntry,
    definitions: ReadonlyArray<Definition>,
    generatedModule: string,
): (Definition & { exported: boolean })[] => {
    if (definitions.length === 0) {
        return [];
    }

    // The composed class-A entry star-re-exports `_generated/{agents,containers,
    // workflows}` for every kind the project declares (`@lunora/vite`'s
    // `GENERATED_CLASS_MODULES`), so every declaration IS exported. There is no
    // file to lex — reading it as "unexported" is the bug this branch fixes.
    if (entry.composed) {
        return definitions.map((definition) => {
            return { ...definition, exported: true };
        });
    }

    if (entry.path === undefined) {
        return definitions.map((definition) => {
            return { ...definition, exported: false };
        });
    }

    const code = readFileSync(entry.path, "utf8");
    const starReexport = new RegExp(String.raw`\bexport\s*\*\s*from\s*["'][^"']*_generated\/${generatedModule}(?:\.js)?["']`).test(code);

    // The names exported as a runtime VALUE — the only ones safe to bind, since
    // wrangler validates a binding's `class_name` against the worker's exports at
    // deploy. Type-only exports (which compile away) are rejected per entry.
    let valueExportedNames: Set<string>;

    try {
        const [, exports] = lexModule(code);

        // `es-module-lexer` already omits `export type Foo` and the separate
        // `export type { Foo }` from its export list; the one type-only shape it
        // still lists is the inline `export { type Foo }`, dropped here per entry.
        // What remains are the real value exports — so a value `export class Foo {}`
        // is NOT suppressed by an unrelated `export type { Foo }` elsewhere in the
        // entry (the prior unanchored whole-file regex's bug).
        // NB: coupling — `isTypeOnlyExportEntry` reads the source at `exportEntry.ls`/`exportEntry.s`,
        // the byte offsets `es-module-lexer` reports for THIS `code`, so it must be
        // passed the same `code` these `exports` were lexed from.
        valueExportedNames = new Set(exports.filter((exportEntry) => !isTypeOnlyExportEntry(code, exportEntry)).map((exportEntry) => exportEntry.n));
    } catch {
        // Fallback for an unparseable (mid-edit) entry: a blind whole-file sweep for
        // an `export … <className>` that is not a type-only export. Less precise than
        // the lexer path — see the regex-fallback detector called just below.
        valueExportedNames = new Set(
            definitions
                .map((definition) => definition.className)
                .filter(
                    (className) =>
                        new RegExp(String.raw`\bexport\b[^\n;]*\b${escapeRegExp(className)}\b`, "u").test(code) &&
                        !isTypeOnlyExportRegexFallback(code, className),
                ),
        );
    }

    return definitions.map((definition) => {
        const exported = starReexport || valueExportedNames.has(definition.className);

        return { ...definition, exported };
    });
};

export type { DurableObjectClass, DurableObjectSpec, GeneratedClassModule, WorkerEntry };
// `COMPOSED_WORKER_ENTRY`, `WORKER_ENTRY_FALLBACKS` and `LUNORA_WORKER_VIRTUAL_ID`
// are shared with the wrangler validator's exported-class check, which answers
// the same question ("which classes does the entry export as runtime values?")
// against the same file. The validator keeps its own path resolver because it
// resolves `main` from the `--env` view relative to the config file, which this
// one (deliberately projectRoot-relative, and reading the top level) does not.
//
// It also keeps its own READER: this side lexes with `es-module-lexer` (it is
// already lexing the same file's IMPORTS for capability inference), the
// validator parses with ts-morph. That is a real duplication and the two can
// disagree — this one PROVISIONS a binding, the other now BLOCKS a deploy on
// one — so they are worth collapsing onto the ts-morph reader. Not done here:
// this side feeds `reconcile`, and changing what it provisions is a separate
// change from fixing what the validator reports.
// `resolveWorkerEntry` returns a {@link WorkerEntry}, not a path: the class-A
// composed entry (`main: "virtual:lunora/worker"`) has no file, and reading that
// as "no worker entry" is what left every container/workflow/agent unprovisioned.
// The composed-entry class list is shared for the same reason: the validator
// decides that entry's exports from it, so "what class-A composition provisions"
// and "what class-A composition is allowed to bind" cannot drift.

export {
    COMPOSED_ENTRY_DURABLE_OBJECTS,
    COMPOSED_WORKER_ENTRY,
    detectClassExports,
    detectExportedDurableObjects,
    DURABLE_OBJECT_BINDINGS,
    GENERATED_CLASS_MODULES,
    GENERATED_DIRECTORY,
    isFrameworkDurableObject,
    isGeneratedOutput,
    LUNORA_WORKER_VIRTUAL_ID,
    NON_SOURCE_DIRECTORIES,
    resolveWorkerEntry,
    SOURCE_DOT_DIRECTORIES,
    WORKER_ENTRY_FALLBACKS,
};
