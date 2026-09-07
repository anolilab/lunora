/**
 * Cloudflare Worker deploy entry for this Analog app.
 *
 * Analog runs SSR through Nitro's `cloudflare-module` preset, which emits a
 * worker at `dist/analog/server/index.mjs` that does NOT re-export Durable
 * Object classes, and Nitro has no hook that appends extra named exports to
 * that entry — so pointing `main` straight at it makes `wrangler deploy` fail
 * with "Your Worker depends on the following Durable Objects, which are not
 * exported in your entrypoint file: ShardDO." (`vite build` succeeds
 * regardless; the gap only surfaces at deploy.)
 *
 * This wrapper is the single worker `wrangler.jsonc` points `main` at. It
 * composes Nitro's handler with Lunora's, so the deployed worker carries
 * everything Cloudflare needs — Analog SSR, the in-Nitro Lunora plane
 * (`/_lunora/**`, served by `src/server/routes/_lunora/[...].ts`), the `ShardDO`
 * Durable Object, and every non-`fetch` entrypoint — in one deploy. Same shape
 * as the Nuxt template's root `worker.ts`.
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
 * bundles this entry, following the import to `dist/analog/server/index.mjs` and
 * its relative chunks. `dist/` exists at deploy time because the `deploy` script
 * runs `vite build` first.
 */
// `@ts-ignore`, not `@ts-expect-error`: what TypeScript makes of this specifier
// depends on whether a build has run. Before the first `vite build` the file does
// not exist (TS2307); after one it does, as untyped emitted JS (TS7016). Either
// way `@ts-expect-error` would report itself as unused in the state the other
// diagnostic does not fire, so only `@ts-ignore` is correct in both.
// @ts-ignore -- emitted by Nitro's `cloudflare-module` preset at build time
// eslint-disable-next-line import/extensions -- real emitted Nitro output, bundled by wrangler (not bundler-resolution TS)
import nitro from "./dist/analog/server/index.mjs";
import type { ExecutionContextLike, ScheduledControllerLike } from "lunorash/runtime";

import app, { ShardDO } from "./lunora/server";

/**
 * The composed module worker. Nitro keeps `fetch` (Analog SSR owns every route,
 * including the `/_lunora/**` one it serves) and its own `tail` / `trace`; the
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
