/**
 * The module specifiers a Lunora authoring factory may legitimately be imported
 * from — the single source of truth every discoverer gates on.
 *
 * There are three forms, and **all three must be accepted**.
 * `@lunora/server` is the granular package. `lunorash/server` is the same surface
 * through the unscoped umbrella, which is the recommended single-dependency
 * install — codegen even emits `lunorash/*` imports into `_generated/*` when a
 * project depends on it. `./_generated/server` is the project-bound re-export, for
 * the factories `emitServer` re-exports (`query`/`mutation`/`action`/`internal*`/
 * `defineMutator`); that is the Convex idiom and the form that gives `ctx` its
 * schema-typed `db`, so it is what the docs recommend.
 *
 * Missing a form is a **silent drop**, not a type error: discovery skips the
 * declaration, so the function never lands in `LUNORA_FUNCTIONS` (every call
 * 404s), the cron file is never emitted (the schedule never fires), or
 * `LUNORA_MIGRATIONS` comes back empty (`lunora migrate up` finds nothing) — and
 * codegen still exits `ok`. Each discoverer previously hard-coded its own subset
 * and three of them were missing the umbrella; hence this shared module.
 */

/** Relative depth varies by file location, and the `.js` extension is present under NodeNext. */
const GENERATED_SERVER_RE = /(?:^|\/)_generated\/server(?:\.js)?$/u;

/** The `@lunora/server` surface, granular or through the umbrella. */
const SERVER_PACKAGE_SPECIFIERS = new Set(["@lunora/server", "lunorash/server"]);

/**
 * True for `@lunora/server` or its `lunorash/server` umbrella subpath — the gate
 * for factories the generated `server.ts` does NOT re-export (`defineShape`,
 * `defineIdentity`, `defineEnv`, `defineMigration`, …).
 */
const isServerPackageModule = (moduleSpecifier: string): boolean => SERVER_PACKAGE_SPECIFIERS.has(moduleSpecifier);

/**
 * True for the generated `_generated/server` re-export at any relative depth,
 * with or without the `.js` extension.
 */
const isGeneratedServerModule = (moduleSpecifier: string): boolean => GENERATED_SERVER_RE.test(moduleSpecifier);

/**
 * True for every form a factory re-exported by `_generated/server.ts` may come
 * from — the gate for `query`/`mutation`/`action`/`internal*` and `defineMutator`.
 */
const isServerSurfaceModule = (moduleSpecifier: string): boolean => isServerPackageModule(moduleSpecifier) || isGeneratedServerModule(moduleSpecifier);

/**
 * Specifiers `cronJobs` may come from: `@lunora/scheduler` declares it and
 * `@lunora/server` re-exports it, so both — plus the umbrella's `server` subpath.
 * The umbrella ships no `./scheduler` subpath, so `@lunora/scheduler` stays
 * scoped either way.
 */
const CRON_SOURCE_SPECIFIERS = new Set(["@lunora/scheduler", ...SERVER_PACKAGE_SPECIFIERS]);

/** True for every module `cronJobs` may legitimately be imported from. */
const isCronSourceModule = (moduleSpecifier: string): boolean => CRON_SOURCE_SPECIFIERS.has(moduleSpecifier);

export { isCronSourceModule, isGeneratedServerModule, isServerPackageModule, isServerSurfaceModule };
