import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

import type { DetectedFramework } from "./detect-framework";
import type { LunoraPluginContext } from "./framework-detect-plugin";
import type { ResolvedLunoraPluginOptions } from "./types";

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
 * Whether the `virtual:lunora/worker` virtual entry should be resolved. This is
 * intentionally independent of `options.cloudflare`: `cloudflare: false` means
 * "don't add the Cloudflare Vite plugin a second time" (the user added it
 * themselves, e.g. to control plugin ordering), NOT "disable the composed worker
 * entry". The worker virtual must be resolvable whenever the CF integration is
 * present — whether Lunora added it or the user did.
 */
const isWorkerVirtualActive = (context: LunoraPluginContext): boolean => isAutoComposable(context);

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
const buildWorkerEntrySource = (framework: DetectedFramework, generatedImportBase: string, hasContainers = false): string => {
    const wiring = CLASS_A_WIRING[framework];

    if (wiring === undefined) {
        throw new Error(`[lunora] no class-A worker wiring for framework "${framework}"`);
    }

    // wrangler refuses to deploy a `containers[].class_name` the worker doesn't
    // export. A class-A app has no hand-written entry to add the re-export to,
    // so the composed entry must forward the generated container DO classes
    // itself — but only when the project declares containers (otherwise the
    // file doesn't exist and the import would fail).
    const containersReexport = hasContainers ? `\nexport * from "${generatedImportBase}/containers";\n` : "";

    return `// Generated by @lunora/vite — class-A worker composition (PLAN4 M2).
// Do not edit: emitted from the detected framework (${framework}). Point your
// wrangler \`main\` here (or re-export it) instead of hand-wiring createWorker.
import { composeWorker } from "@lunora/runtime";
${wiring.imports}
import { LUNORA_FUNCTIONS } from "${generatedImportBase}/functions";
import { openApiSpec } from "${generatedImportBase}/openapi";
import { createShardDO } from "${generatedImportBase}/shard";

export const ShardDO = createShardDO();
${containersReexport}

let worker;

export default {
    async fetch(request, env, context) {
        worker ??= composeWorker({
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
 * resolvable so the user-supplied CF plugin can find the wrangler `main`.
 */
export const frameworkComposePlugin = (options: ResolvedLunoraPluginOptions, context: LunoraPluginContext): Plugin => {
    // Virtual modules have no real filesystem path, so relative specifiers like
    // "./lunora/_generated/functions" cannot be resolved by Vite/rolldown from
    // `\0virtual:lunora/worker`. We must use an absolute path so the bundler can
    // locate the files regardless of the virtual module's (non-existent) base dir.
    const generatedImportBase = resolve(options.projectRoot, options.generatedDir.replace(TRAILING_SLASH, ""));

    return {
        load(id) {
            if (id === RESOLVED_LUNORA_WORKER_ID && isWorkerVirtualActive(context) && context.framework !== undefined) {
                // `_generated/containers.ts` exists only when the project declares
                // containers; codegen has already run by load time, so this fs
                // check decides whether the composed entry re-exports them.
                const hasContainers = existsSync(join(generatedImportBase, "containers.ts"));

                return buildWorkerEntrySource(context.framework.framework, generatedImportBase, hasContainers);
            }

            return undefined;
        },
        name: "lunora:framework-compose",
        resolveId(id) {
            if (id === LUNORA_WORKER_VIRTUAL_ID && isWorkerVirtualActive(context)) {
                return RESOLVED_LUNORA_WORKER_ID;
            }

            return undefined;
        },
    };
};

export type { ClassAWiring };
export { buildWorkerEntrySource, CLASS_A_WIRING, isAutoComposable, LUNORA_WORKER_VIRTUAL_ID, RESOLVED_LUNORA_WORKER_ID };
