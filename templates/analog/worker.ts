/**
 * Cloudflare Worker deploy entry for this Analog app.
 *
 * Analog runs SSR through Nitro's `cloudflare-module` preset, which emits a
 * worker at `dist/analog/server/index.mjs` exporting ONLY the SSR `fetch`
 * handler as `default` (`nitropack/dist/presets/cloudflare/runtime/cloudflare-module.mjs`
 * is a single `export default createHandler({...})`). It does NOT re-export
 * Durable Object classes, and Nitro has no hook that appends extra named
 * exports to that entry — so pointing `main` straight at it makes
 * `wrangler deploy` fail with "Your Worker depends on the following Durable
 * Objects, which are not exported in your entrypoint file: ShardDO."
 * (`vite build` succeeds regardless; the gap only surfaces at deploy.)
 *
 * This wrapper is the single worker `wrangler.jsonc` points `main` at. It
 * re-exports Nitro's SSR handler as `default` AND the Lunora `ShardDO` class, so
 * the composed worker carries everything Cloudflare needs — Analog SSR, the
 * in-Nitro Lunora plane (`/_lunora/**`, served by
 * `src/server/routes/_lunora/[...].ts`), and the `ShardDO` Durable Object — in
 * one deploy. Same shape as the Nuxt template's root `worker.ts`.
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
export { default } from "./dist/analog/server/index.mjs";
export { ShardDO } from "./lunora/server";
