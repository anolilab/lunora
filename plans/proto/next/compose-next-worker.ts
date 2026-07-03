/**
 * Spike 110 prototype — the OpenNext-on-Cloudflare composition seam for
 * `@lunora/next`, modelled as a standalone, runnable function.
 *
 * This is a faithful, dependency-free model of what the real integration does with
 * the SHIPPED `withFrameworkWorker(host, (env) => ({ shardDO: env.SHARD }))`
 * (packages/runtime/src/create-worker.ts:3285). We can't boot `createWorker` +
 * a real `ShardDO` namespace in this sandbox (needs workerd + a Vectorize/DO
 * binding), so the prototype isolates the ONE decision the spike must prove: at
 * the OpenNext *custom-worker boundary*, reserve `/_lunora/*` for Lunora and
 * delegate everything else to the OpenNext handler — and return Lunora's response
 * (including a `101 Switching Protocols` WebSocket upgrade with its `webSocket`
 * field) VERBATIM.
 *
 * Real wiring the template ships (custom worker; `main` in wrangler points here):
 *
 * ```ts
 * // src/worker.ts  (wrangler main)
 * // @ts-expect-error generated at build time by @opennextjs/cloudflare
 * import { default as openNextHandler } from "./.open-next/worker.js";
 * import { withFrameworkWorker } from "@lunora/runtime";
 *
 * export default withFrameworkWorker(openNextHandler, (env) => ({ shardDO: env.SHARD }));
 *
 * // ShardDO must be exported from the SAME worker entry (+ bound in wrangler.jsonc):
 * export { ShardDO } from "./lunora/server";
 * // When OpenNext's DO-backed cache/queue is enabled, re-export its DO classes too:
 * // export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
 * ```
 *
 * A Next.js Route Handler (`app/_lunora/[...path]/route.ts`) can serve RPC (a plain
 * POST/GET -> Response), but CANNOT carry the WebSocket upgrade: Cloudflare's 101
 * response needs a non-standard `webSocket` field, and OpenNext's request/response
 * adapter round-trip (Cloudflare Request -> Next server -> Web Response -> Cloudflare
 * Response) does not preserve it. So the WS path — Lunora's core realtime feature —
 * must live at the worker boundary. This prototype proves the boundary preserves it.
 */

/** What a Cloudflare `fetch` handler may return: a real `Response`, or a 101 upgrade carrying a `webSocket`. */
export type ResponseLike = Response | { readonly status: number; readonly webSocket?: unknown };

export interface ExecutionContextLike {
    passThroughOnException?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** The OpenNext-emitted handler shape (`.open-next/worker.js` default export). */
export interface FetchHost {
    fetch: (request: Request, env: unknown, context?: ExecutionContextLike) => Promise<ResponseLike> | ResponseLike;
}

/** Lunora's realtime plane bridge (`createLunoraHandler()` -> `(request, env, ctx) => Response`). */
export type LunoraHandler = (request: Request, env: unknown, context?: ExecutionContextLike) => Promise<ResponseLike> | ResponseLike;

export interface ComposeOptions {
    /** Reserved prefix for Lunora's realtime plane. Default `/_lunora/`. */
    prefix?: string;
}

const DEFAULT_PREFIX = "/_lunora/";

/**
 * Compose the OpenNext host with Lunora's realtime handler into one worker
 * `{ fetch }`. Requests under `prefix` (rpc / rpc-batch / ws / admin / migrate)
 * go to Lunora; everything else delegates to OpenNext. The chosen response is
 * returned verbatim, so a WebSocket upgrade survives unchanged.
 *
 * The real seam is `withFrameworkWorker`; this mirrors its dispatch so the spike's
 * unit test can assert the contract without workerd.
 */
export const composeNextWorker = (host: FetchHost, lunora: LunoraHandler, options: ComposeOptions = {}): FetchHost => {
    const prefix = options.prefix ?? DEFAULT_PREFIX;

    return {
        fetch: (request, env, context) => {
            const { pathname } = new URL(request.url);

            // Reserve the realtime plane. `startsWith(prefix)` also matches the exact
            // prefix-less path (`/_lunora`) via the trailing slash the constants carry
            // (`/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/...`).
            if (pathname.startsWith(prefix)) {
                return lunora(request, env, context);
            }

            return host.fetch(request, env, context);
        },
    };
};
