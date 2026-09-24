/**
 * Cloudflare Worker deploy entry for this Nuxt app.
 *
 * Nuxt's Nitro `cloudflare_module` preset emits a worker at
 * `.output/server/index.mjs` that does NOT re-export Durable Object classes. So
 * `wrangler deploy` against that output alone fails: the `SHARD` binding names
 * `ShardDO`, which is bundled into the Nitro output (via `@lunora/nuxt`'s
 * `#lunora/app` alias) but never exported. (`nuxt build` succeeds regardless;
 * the gap only surfaces at deploy with "Durable Objects … not exported in your
 * entrypoint file".)
 *
 * This wrapper is the single worker `wrangler.jsonc` points `main` at. It
 * composes Nitro's handler with Lunora's, so the deployed worker carries
 * everything Cloudflare needs — Nuxt SSR, the in-worker Lunora plane
 * (`/_lunora/**`, mounted by `@lunora/nuxt`), the `ShardDO` Durable Object, and
 * every non-`fetch` entrypoint — in one deploy.
 *
 * Why it composes rather than re-exporting Nitro's `default`: Nitro's handler
 * DOES export `scheduled` / `queue` / `email`, but each only fires the matching
 * `cloudflare:*` Nitro hook, and nothing registers a listener for one. Lunora's
 * `scheduled` (crons), `queue` (`defineQueue` consumers) and `email` (inbound
 * mail) therefore never ran — while `lunora deploy` provisions the matching
 * `triggers.crons` / queue consumer from the same codegen discovery, so the
 * trigger existed and fired into an empty hook: no error, no invocation, a cron
 * that silently never runs. Both sides are chained here so a Nitro plugin
 * listening on those hooks keeps working.
 *
 * The `.mjs` extension on the Nitro import is required: it's a real emitted file
 * (not TS source), and wrangler/esbuild — not the bundler-resolution TS config —
 * bundles this entry, following the import to `.output/server/index.mjs` and its
 * relative chunks. `.output/` exists at deploy time because the `deploy` script
 * runs `nuxt build` first.
 */
// `@ts-ignore`, not `@ts-expect-error`: what TypeScript makes of this specifier
// depends on whether a build has run. Before the first `nuxt build` the file does
// not exist (TS2307); after one it does, as untyped emitted JS (TS7016). Either
// way `@ts-expect-error` would report itself as unused in the state the other
// diagnostic does not fire, so only `@ts-ignore` is correct in both.
// @ts-ignore -- emitted by Nitro's `cloudflare_module` preset at build time
// eslint-disable-next-line import/extensions -- real emitted Nitro output, bundled by wrangler (not bundler-resolution TS)
import nitro from "./.output/server/index.mjs";
import type { ExecutionContextLike, ScheduledControllerLike } from "lunorash/runtime";

import app, { ShardDO } from "./lunora/server";

/**
 * The composed module worker. Nitro keeps `fetch` (Nuxt SSR owns every route,
 * including the `/_lunora/**` one it mounts) and its own `tail` / `trace`; the
 * three event entrypoints Lunora also serves run both handlers.
 */
const worker = {
    ...nitro,

    async email(message: unknown, environment: unknown, context: ExecutionContextLike): Promise<void> {
        await nitro.email?.(message, environment, context);
        await app.email?.(message, environment, context);
    },

    async queue(batch: unknown, environment: unknown, context: ExecutionContextLike): Promise<void> {
        await nitro.queue?.(batch, environment, context);
        await app.queue?.(batch, environment, context);
    },

    async scheduled(controller: ScheduledControllerLike, environment: unknown, context: ExecutionContextLike): Promise<void> {
        await nitro.scheduled?.(controller, environment, context);
        await app.scheduled(controller, environment, context);
    },
};

export { ShardDO };
export default worker;
