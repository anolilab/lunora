import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { projectUsesUmbrella } from "@lunora/config";
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

/**
 * The `_generated/` modules whose exported classes wrangler validates a
 * `class_name` against: container Durable Objects, workflow entrypoints, and
 * agent (workflow) entrypoints — the same three kinds `reconcile-bindings`
 * writes into `wrangler.jsonc`. The composed entry star-re-exports each module
 * the project actually has.
 */
const GENERATED_CLASS_MODULES = ["agents", "containers", "workflows"] as const;

/** One {@link GENERATED_CLASS_MODULES} entry. */
type GeneratedClassModule = (typeof GENERATED_CLASS_MODULES)[number];

/**
 * Build the source of the virtual class-A worker entry. Pure (no fs / no Vite),
 * so the emitted composition is unit-testable in isolation.
 *
 * The emitted module imports the framework SSR handler + the project's
 * generated artifacts (functions registry, OpenAPI doc, `createShardDO`) and
 * composes them through `composeWorker` — reserved `/_lunora/*` paths route to
 * Lunora, everything else falls through to the framework SSR handler. The
 * `generatedImportBase` MUST be an absolute filesystem path to the `_generated`
 * directory. Virtual modules have no real filesystem path, so relative specifiers
 * like `./lunora/_generated/functions` cannot be resolved by Vite/rolldown from a
 * virtual module id. Absolute paths are resolved correctly in all environments
 * (Vite 8 + rolldown 1.x confirmed).
 */
const buildWorkerEntrySource = (
    framework: DetectedFramework,
    generatedImportBase: string,
    classModules: ReadonlyArray<GeneratedClassModule> = [],
    useUmbrella = false,
    allowUnauthenticatedShardAccess = false,
    shard: LunoraShardConfig = {},
): string => {
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

    // Umbrella-aware runtime import (`@lunora/config`'s `projectUsesUmbrella`,
    // the same detector the policy scaffolder writes imports with): the generated
    // `_generated/*` already use `lunorash/*` for umbrella projects, so the composed
    // worker must match or the bare `@lunora/runtime` won't resolve.
    const runtimeModule = useUmbrella ? "lunorash/runtime" : "@lunora/runtime";

    // wrangler refuses to deploy a `class_name` the worker doesn't export, and
    // that rule covers ALL THREE generated class kinds — containers
    // (`durable_objects`), workflows and agents (both `workflows[]`), which is
    // exactly the set `reconcile-bindings` provisions. A class-A app has no
    // hand-written entry to add the re-exports to, so the composed entry must
    // forward every generated class itself. Emitted per module that actually
    // exists (codegen only writes the file when the project declares that kind),
    // otherwise the import would fail to resolve.
    const classReexports = classModules.map((module) => `\nexport * from "${base}/${module}";\n`).join("");

    // A class-A app never calls the generated `defineApp()` builder — it has no
    // worker entry to call it FROM — so this emitted line is its only route to
    // `createShardDO(config)`. Bare, it left `cdc` and the whole reactive query
    // cache unreachable for every class-A template.
    //
    // Keys are sorted so the emitted entry is stable across config-object
    // literal ordering, and `JSON.stringify` drops `undefined`-valued keys — so
    // an empty (or all-default) `shard` emits `createShardDO()` exactly as
    // before rather than a noisy `createShardDO({})`. Values are booleans,
    // numbers and a closed string union, all of which `JSON.stringify` escapes,
    // so nothing here can break out of the literal.
    const shardArgument = JSON.stringify(Object.fromEntries(Object.entries(shard).toSorted(([a], [b]) => a.localeCompare(b))));
    const shardConfig = shardArgument === "{}" ? "" : shardArgument;

    return `// Generated by @lunora/vite — class-A worker composition (PLAN4 M2).
// Do not edit: emitted from the detected framework (${framework}). Point your
// wrangler \`main\` here (or re-export it) instead of hand-wiring createWorker.
import { composeWorker } from "${runtimeModule}";
${wiring.imports}
import { LUNORA_FUNCTIONS } from "${base}/functions";
import { openApiSpec } from "${base}/openapi";
import { createShardDO } from "${base}/shard";

export const ShardDO = createShardDO(${shardConfig});
${classReexports}

let worker;

export default {
    async fetch(request, env, context) {
        worker ??= composeWorker({${allowUnauthenticatedShardAccess ? "\n            allowUnauthenticatedShardAccess: true," : ""}
            functions: LUNORA_FUNCTIONS,
            httpRouter: ${wiring.handler},
            openApiSpec,
            routes: {},
            shardDO: env.SHARD,
        });

        return worker.fetch(request, env, context);
    },
};
`;
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
    const useUmbrella = projectUsesUmbrella(options.projectRoot);

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

                return buildWorkerEntrySource(
                    context.framework.framework,
                    generatedImportBase,
                    classModules,
                    useUmbrella,
                    options.allowUnauthenticatedShardAccess,
                    options.shard,
                );
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

export type { ClassAWiring, GeneratedClassModule };
export { buildWorkerEntrySource, CLASS_A_WIRING, GENERATED_CLASS_MODULES, isAutoComposable, LUNORA_WORKER_VIRTUAL_ID, RESOLVED_LUNORA_WORKER_ID };
