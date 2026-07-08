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
 * This file is only ever bundled by Nitro; `h3`'s `defineEventHandler` is its
 * sole framework entry. We use a namespace import so the seam spans the h3
 * v1 → v2 break: v1 exposes `toWebRequest(event)`, while the v2 web-standards
 * rewrite removed it and carries the web `Request` directly as `event.req`. A
 * static `import { toWebRequest }` would throw at module-eval under v2 (missing
 * named export), so `resolveWebRequest` feature-detects it at runtime instead.
 */
// `h3` ships no runtime type declarations — the module is resolved at runtime
// by Nitro. `tsc --noEmit` would error here (and it's expected: the actual types
// are applied by `nuxt-module-build`/vue-tsc, not by the project's tsc).
// eslint-disable-next-line import/no-namespace, @typescript-eslint/prefer-ts-expect-error -- a namespace import is required to feature-detect `toWebRequest` (h3 v1→v2 break); `ts-ignore` because tsc can't resolve h3 declarations but the module builder does.
// @ts-ignore -- h3 module is resolved by nuxt-module-build, not tsc
import * as h3 from "h3";

// `#lunora/app` is a virtual specifier the @lunora/nuxt module registers
// (nuxt.options.alias + nitro virtual). Its default export is the project's
// Lunora worker (`defineApp().build()` or a `createWorker(...)` result).
import lunoraApp from "#lunora/app";

import { resolveCloudflare } from "../cloudflare";
import { resolveWebRequest } from "../h3-request";
import { delegateToLunora } from "../handler";

/**
 * Forward `/_lunora/**` to the Lunora worker. We reconstruct a Web `Request`
 * from the H3 event (Lunora speaks the Web Fetch contract — RPC bodies and the
 * WebSocket `Upgrade` handshake), resolve the Cloudflare `env`/`ExecutionContext`
 * off the event, and return the worker's `Response` verbatim (H3 streams it,
 * including a `101 Switching Protocols` upgrade with its `webSocket`).
 */
export default h3.defineEventHandler(async (event: unknown) => {
    const { ctx, env } = resolveCloudflare(event as never);
    const request = resolveWebRequest(h3, event);

    return delegateToLunora(lunoraApp, request, env, ctx);
});
