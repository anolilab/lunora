import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GeneratedClassModule } from "@lunora/config";
import { APP_CONFIG_FILENAME, GENERATED_CLASS_MODULES } from "@lunora/config";
import { moduleExportsValue } from "@lunora/config/cloudflare";
import { LunoraError } from "@lunora/errors";
import type { Plugin } from "vite";

import type { DetectedFramework } from "./detect-framework";
import type { LunoraPluginContext } from "./framework-detect-plugin";
import type { LunoraShardConfig, ResolvedLunoraPluginOptions } from "./types";

/**
 * The virtual module id the Lunora plugin resolves to a generated, class-A
 * worker entry. A class-A template points its wrangler `main` at this id (or
 * re-exports it from a one-line `src/server.ts`) and never hand-writes
 * `createWorker({ httpRouter })` — the plugin composes the framework's SSR
 * handler under `composeWorker`'s `httpRouter` seam for it.
 *
 * Exposed publicly so `@lunora/cli`'s build/deploy path and the templates can
 * reference the same constant rather than re-typing the literal.
 */
const LUNORA_WORKER_VIRTUAL_ID: string = "virtual:lunora/worker";

/** Vite prefixes resolved virtual ids with a NUL so other plugins skip them. */
const RESOLVED_VIRTUAL_PREFIX = "\0";
const RESOLVED_LUNORA_WORKER_ID: string = `${RESOLVED_VIRTUAL_PREFIX}${LUNORA_WORKER_VIRTUAL_ID}`;

/**
 * Stub emitted for the worker virtual in the *client* (browser) environment. The
 * composed entry pulls in worker-only runtime — `composeWorker`, `createShardDO`,
 * the framework's server handler — none of which belongs in a browser chunk. The
 * client never imports `virtual:lunora/worker` in practice, so this only hardens
 * against an accidental import leaking worker code into the client bundle.
 */
const CLIENT_WORKER_STUB = `// @lunora/vite — the composed worker entry is worker-only and unavailable in the client environment.
export default {};
`;

/** Strip a single trailing slash from a dir so the emitted import has exactly one separator. */
const TRAILING_SLASH = /\/$/;

/**
 * Per-class-A-framework wiring the generated worker entry needs: how to obtain
 * the framework's SSR handler as a `composeWorker`-compatible `httpRouter`.
 *
 * `imports` is the full import statement(s) the generated entry needs (each
 * framework controls its own import shape — a namespace import, or a named one);
 * `handler` is a JS expression (evaluated in the generated module's scope, where
 * `imports`' symbols are in scope) that yields an `HttpRouterLike`
 * (`{ fetch(request, env?, ctx?) }`). Both are data — not codegen branches — so
 * the set of supported class-A frameworks is one readable table and adding a
 * framework is a pure data edit.
 *
 * Honesty note: these handler expressions encode each framework's *documented*
 * Cloudflare SSR-handler shape — the same expressions the hand-wired template
 * entries use today (React Router's `createRequestHandler` over its virtual
 * server build; SolidStart's `cloudflare-module` handler; TanStack Start's
 * server entry). The plugin just emits them so the developer doesn't.
 */
interface ClassAWiring {
    /** JS expression yielding the `httpRouter` ({ fetch }), referencing symbols brought in by `imports`. */
    handler: string;
    /** The import statement(s) the generated entry needs to bring `handler`'s symbols into scope. */
    imports: string;
}

const CLASS_A_WIRING: Readonly<Partial<Record<DetectedFramework, ClassAWiring>>> = {
    "react-router": {
        // `@react-router/dev` provides `virtual:react-router/server-build`; the
        // runtime helper turns it into a `(request) => Promise<Response>`, which
        // is exactly the `httpRouter.fetch` contract. Needs a named import.
        handler: '{ fetch: (request) => createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE)(request) }',
        imports: 'import { createRequestHandler } from "react-router";',
    },
    "solid-start": {
        // SolidStart's `cloudflare-module` preset default-exports a fetch
        // handler — structurally an `HttpRouterLike` already.
        handler: "ssrModule.default",
        imports: 'import * as ssrModule from "@solidjs/start/server-handler";',
    },
    "tanstack-start": {
        // TanStack Start's server entry default-exports a `{ fetch }` handler.
        handler: "ssrModule.default",
        imports: 'import * as ssrModule from "@tanstack/react-start/server-entry";',
    },
    "tanstack-start-solid": {
        // TanStack Start (Solid)'s server entry default-exports a `{ fetch }`
        // handler — same shape as the React variant, different package.
        handler: "ssrModule.default",
        imports: 'import * as ssrModule from "@tanstack/solid-start/server-entry";',
    },
    vinext: {
        // vinext (Next.js on Vite) default-exports a `{ fetch(request, env, ctx) }`
        // handler — exactly the `httpRouter` contract. `composeWorker` forwards
        // `env` (with `__lunoraCtx`) and the execution `ctx`, so vinext's bindings
        // + `ctx.waitUntil` cache writes work unchanged. `fetch-handler` is the
        // router-selected entry: vinext's Vite plugin resolves it to the App-Router
        // or Pages-Router handler at build time, so one wiring row covers both.
        handler: "ssrModule.default",
        imports: 'import * as ssrModule from "vinext/server/fetch-handler";',
    },
};

/**
 * Whether the detected framework is one the plugin can auto-compose. Only
 * class-A frameworks with a known SSR-handler wiring qualify; everything else
 * (class B/C, `none`) falls back to the existing flow.
 */
const isAutoComposable = (context: LunoraPluginContext): boolean => {
    const detected = context.framework;

    return detected?.class === "A" && CLASS_A_WIRING[detected.framework] !== undefined;
};

/** Trailing `.ts` on the app-config path — the bundler resolves the extension, so the emitted specifier drops it. */
/** The named export the composed entry imports from {@link APP_CONFIG_FILENAME}. */
const APP_CONFIG_EXPORT = "configureApp";

/**
 * Build the source of the virtual class-A worker entry. Pure (no fs / no Vite),
 * so the emitted composition is unit-testable in isolation.
 *
 * The emitted module imports the framework SSR handler and the project's
 * generated `defineApp()` builder, and mounts the handler as the app's
 * `httpRouter` — reserved `/_lunora/*` paths route to Lunora, everything else
 * falls through to the framework SSR handler. `.build()` yields the whole
 * module worker (`fetch` / `scheduled` / `queue` / `email`) plus `ShardDO`. The
 * `generatedImportBase` MUST be an absolute filesystem path to the `_generated`
 * directory. Virtual modules have no real filesystem path, so relative specifiers
 * like `./lunora/_generated/functions` cannot be resolved by Vite/rolldown from a
 * virtual module id. Absolute paths are resolved correctly in all environments
 * (Vite 8 + rolldown 1.x confirmed).
 */
interface WorkerEntryComposition {
    /** Whether to allow unauthenticated shard access — `.extend(...)` on the builder. */
    allowUnauthenticatedShardAccess?: boolean;
    /** Absolute path to the app's own `configureApp` module, when it has one. */
    appConfigModule?: string;
    /** The `_generated/` class modules that exist, each star-re-exported. */
    classModules?: ReadonlyArray<GeneratedClassModule>;
    /** Per-shard knobs, each key named after the builder method that sets it. */
    shard?: LunoraShardConfig;
}

const buildWorkerEntrySource = (framework: DetectedFramework, generatedImportBase: string, composition: WorkerEntryComposition = {}): string => {
    const { allowUnauthenticatedShardAccess = false, appConfigModule, classModules = [], shard = {} } = composition;

    const wiring = CLASS_A_WIRING[framework];

    if (wiring === undefined) {
        throw new LunoraError("INTERNAL", `[lunora] no class-A worker wiring for framework "${framework}"`);
    }

    // `resolve()` yields backslash-separated paths on Windows (e.g.
    // `C:\Users\dev\app\lunora\_generated`). Interpolated verbatim into the JS
    // string literals below, those backslashes are escape sequences — `\U` is an
    // invalid unicode escape (a hard SyntaxError) and `\l`/`\a` are silently
    // swallowed into an unresolvable specifier. Posix-ify first: Vite/rolldown
    // resolve `C:/…` ids fine, so the emitted imports are valid in all environments.
    const base = generatedImportBase.replaceAll("\\", "/");

    // wrangler refuses to deploy a `class_name` the worker doesn't export, and
    // that rule covers ALL THREE generated class kinds — containers
    // (`durable_objects`), workflows and agents (both `workflows[]`), which is
    // exactly the set `reconcile-bindings` provisions. A class-A app has no
    // hand-written entry to add the re-exports to, so the composed entry must
    // forward every generated class itself. Emitted per module that actually
    // exists (codegen only writes the file when the project declares that kind),
    // otherwise the import would fail to resolve.
    const classReexports = classModules.map((module) => `\nexport * from "${base}/${module}";\n`).join("");

    // `ctx.scheduler.runAfter` / `runAt` need a `SchedulerDO` namespace on the
    // worker (`create-worker`'s `schedulerDO`), and this entry is generated — so
    // a class-A project had no file to add the re-export to and deferred dispatch
    // was unreachable.
    //
    // Keyed on the generated `scheduler` module, which codegen writes off the
    // same `hasScheduler` that decides whether the builder HAS a `.scheduler()`
    // method — so the call and the method cannot disagree, and the class is
    // forwarded by the ordinary star re-export below rather than a specifier this
    // plugin hard-codes. Keying it on the `wrangler.jsonc` binding instead let a
    // project declare the binding with no scheduler code and get
    // `TypeError: ….scheduler is not a function` at worker boot.
    const schedulerCall = classModules.includes("scheduler") ? `\n    .scheduler({ namespace: (env) => env.SCHEDULER })` : "";

    // `configureApp` receives the builder and returns it, so the framework wiring
    // below (`.httpRouter`, `.build`) stays ours and the app's own capabilities
    // are chained in between. See the docs for why the seam exists at all.
    // Carries its OWN leading newline so an app without the module gets output
    // byte-identical to before, rather than a gratuitous blank line. The `.ts` is
    // stripped for the same reason the sibling `/app` import has none: the
    // bundler resolves the extension.
    const appConfigImport = appConfigModule === undefined ? "" : `\nimport { ${APP_CONFIG_EXPORT} } from "${appConfigModule}";`;
    const [configureOpen, configureClose] = appConfigModule === undefined ? ["", ""] : ["configureApp(", ")"];

    // Each declared `shard` knob as its `defineApp()` builder call. Every
    // `LunoraShardConfig` key is named after the builder method that sets it, so
    // this needs no mapping table. Sorted so the emitted entry is stable across
    // config-object literal ordering; `undefined`-valued keys are dropped so an
    // all-default `shard` adds nothing. Values are booleans, numbers, a closed
    // string union and a flat options object, all of which `JSON.stringify`
    // escapes, so nothing here can break out of the call.
    const shardCalls = Object.entries(shard)
        .filter(([, value]) => value !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `\n    .${key}(${JSON.stringify(value)})`)
        .join("");

    // The composed entry goes through the generated `defineApp()` builder rather
    // than calling `composeWorker` itself.
    //
    // A class-A app has no hand-written worker entry to call `defineApp()` FROM,
    // so this file is its only route to it — and hand-rolling `composeWorker`
    // here meant re-deriving, by hand, everything codegen already knows: the
    // module worker's `scheduled` / `queue` / `email` entrypoints, `cronJobs`,
    // `listSchemaTables`, `logArchive`, the studio's KV + vector introspectors,
    // `identity`, `jurisdiction`, `workflowsClient`, `notifySubscriptionStore`,
    // the `.global()` D1 writer, and the whole `createShardDO` config. It
    // derived four of them, so `lunora deploy` would provision a cron trigger
    // (or a queue consumer) into a worker with no `scheduled` (or `queue`)
    // export and Cloudflare fired it into nothing.
    //
    // `.build()` returns the module-worker object itself, so every handler
    // codegen wired is forwarded by construction — a handler added later cannot
    // go missing here again.
    return `// Generated by @lunora/vite — class-A worker composition (PLAN4 M2).
// Do not edit: emitted from the detected framework (${framework}). Point your
// wrangler \`main\` here (or re-export it) instead of hand-wiring createWorker.
${wiring.imports}
import { defineApp } from "${base}/app";${appConfigImport}

const app = ${configureOpen}defineApp()
    .shard((env) => env.SHARD)${schedulerCall}${configureClose}
    .httpRouter(${wiring.handler})${shardCalls}${allowUnauthenticatedShardAccess ? "\n    .extend(() => ({ allowUnauthenticatedShardAccess: true }))" : ""}
    .build();

export const ShardDO = app.ShardDO;
${classReexports}
export default app;
`;
};

/**
 * The app-config module to compose through, or `undefined` when there is none.
 *
 * The export is verified by PARSING, not by a substring. A file that merely
 * mentions `configureApp` in a comment — or exports it as a type, or as the
 * default, or does not parse — fails the BUNDLE with "does not provide an export
 * named `configureApp`" against a virtual module, the least debuggable error this
 * plugin can produce. Anything unverifiable degrades to composing without it.
 */
const appConfigModule = (projectRoot: string, schemaDirectory: string): string | undefined => {
    const path = resolve(projectRoot, schemaDirectory, APP_CONFIG_FILENAME);

    // Posix-ified and extension-stripped HERE, so the emitter receives a finished
    // specifier: `resolve()` yields backslashes on Windows (invalid escapes once
    // interpolated into a string literal) and the bundler resolves the extension.
    return moduleExportsValue(path, APP_CONFIG_EXPORT) ? path.replaceAll("\\", "/").slice(0, -".ts".length) : undefined;
};

/**
 * Vite plugin that auto-composes a detected class-A meta-framework's SSR
 * handler with Lunora into one Cloudflare Worker (PLAN4 §2.4 / §3 class-A row).
 *
 * Mechanism: it resolves the {@link LUNORA_WORKER_VIRTUAL_ID} virtual module to
 * a generated worker entry that wires the framework SSR handler under
 * `composeWorker`'s `httpRouter` seam — so the developer never writes
 * `createWorker({ httpRouter })`. The composed worker is an ordinary module
 * entry, so it HMRs under `@cloudflare/vite-plugin` exactly like a hand-written
 * one (PLAN4 M5 risk #5): the virtual entry only imports the framework handler
 * and the generated artifacts, both of which the framework's plugin + codegen
 * already make HMR-aware.
 *
 * Safety: it is a strict no-op unless `context.framework.class === "A"` with a
 * known wiring. For class-C (SPA) projects and undetected frameworks it
 * resolves/loads nothing. `cloudflare: false` does NOT disable the virtual
 * entry — it only means "don't add the Cloudflare Vite plugin a second time"
 * (the user supplied it themselves); the composed worker must still be
 * resolvable so the user-supplied CF plugin can find the wrangler `main`. The
 * vinext template depends on exactly that, so making this plugin honour the
 * option would break it.
 */
export const frameworkComposePlugin = (options: ResolvedLunoraPluginOptions, context: LunoraPluginContext): Plugin => {
    // Virtual modules have no real filesystem path, so relative specifiers like
    // "./lunora/_generated/functions" cannot be resolved by Vite/rolldown from
    // `\0virtual:lunora/worker`. We must use an absolute path so the bundler can
    // locate the files regardless of the virtual module's (non-existent) base dir.
    const generatedImportBase = resolve(options.projectRoot, options.generatedDir.replace(TRAILING_SLASH, ""));

    return {
        load(id) {
            if (id === RESOLVED_LUNORA_WORKER_ID && isAutoComposable(context) && context.framework !== undefined) {
                // `@cloudflare/vite-plugin` names the browser environment "client"
                // and the worker environment after the worker; emit the stub there
                // and the real entry everywhere else (worker/SSR). Vite 8 always
                // runs hooks within an environment context, so `this.environment`
                // is guaranteed present here.
                if (this.environment.name === "client") {
                    return CLIENT_WORKER_STUB;
                }

                // `_generated/{agents,containers,workflows}.ts` each exist only when
                // the project declares that kind; codegen has already run by load
                // time, so these fs checks decide which star re-exports the composed
                // entry carries.
                const classModules = GENERATED_CLASS_MODULES.filter((module) => existsSync(join(generatedImportBase, `${module}.ts`)));

                return buildWorkerEntrySource(context.framework.framework, generatedImportBase, {
                    allowUnauthenticatedShardAccess: options.allowUnauthenticatedShardAccess,
                    appConfigModule: appConfigModule(options.projectRoot, options.schemaDir),
                    classModules,
                    shard: options.shard,
                });
            }

            return undefined;
        },
        name: "lunora:framework-compose",
        resolveId(id) {
            if (id === LUNORA_WORKER_VIRTUAL_ID && isAutoComposable(context)) {
                return RESOLVED_LUNORA_WORKER_ID;
            }

            return undefined;
        },
    };
};

export type { ClassAWiring, WorkerEntryComposition };
export { buildWorkerEntrySource, CLASS_A_WIRING, isAutoComposable, LUNORA_WORKER_VIRTUAL_ID, RESOLVED_LUNORA_WORKER_ID };
