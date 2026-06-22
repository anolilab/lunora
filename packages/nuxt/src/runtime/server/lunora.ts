/**
 * Nitro server handler mounted at `/_lunora/**` by the `@lunora/nuxt` module
 * (`addServerHandler`). It is the single-worker seam: every Lunora RPC,
 * WebSocket upgrade, and admin request is forwarded to the project's Lunora
 * worker, which runs *inside* the same Nitro/Cloudflare worker the rest of the
 * Nuxt app deploys as.
 *
 * The worker instance is the project's composed app, imported through the
 * `#lunora/app` virtual the module registers (it points at the app entry — by
 * default `~/lunora/server`, where `defineApp().build()` lives and re-exports
 * `ShardDO`). The same `ShardDO` is re-exported to the Cloudflare worker
 * entrypoint via the project's `exports.cloudflare.ts`, so one deploy carries
 * both the SSR handler and the Durable Object class.
 *
 * This file is only ever bundled by Nitro; `h3`'s `defineEventHandler` and
 * `toWebRequest` are its sole framework imports.
 */
import { defineEventHandler, toWebRequest } from "h3";

// `#lunora/app` is a virtual specifier the @lunora/nuxt module registers
// (nuxt.options.alias + nitro virtual). Its default export is the project's
// Lunora worker (`defineApp().build()` or a `createWorker(...)` result).
import lunoraApp from "#lunora/app";

import { resolveCloudflare } from "../cloudflare";
import { delegateToLunora } from "../handler";

/**
 * Forward `/_lunora/**` to the Lunora worker. We reconstruct a Web `Request`
 * from the H3 event (Lunora speaks the Web Fetch contract — RPC bodies and the
 * WebSocket `Upgrade` handshake), resolve the Cloudflare `env`/`ExecutionContext`
 * off the event, and return the worker's `Response` verbatim (H3 streams it,
 * including a `101 Switching Protocols` upgrade with its `webSocket`).
 */
export default defineEventHandler(async (event) => {
    const { ctx, env } = resolveCloudflare(event as never);
    const request = toWebRequest(event);

    return delegateToLunora(lunoraApp, request, env, ctx);
});
