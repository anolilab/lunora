/**
 * Cloudflare Worker deploy entry for this Nuxt app.
 *
 * Nuxt's Nitro `cloudflare_module` preset emits a worker at
 * `.output/server/index.mjs` that exports only the SSR `fetch` handler as
 * `default` — it does NOT re-export Durable Object classes. So `wrangler deploy`
 * against that output alone fails: the `SHARD` binding names `ShardDO`, which is
 * bundled into the Nitro output (via `@lunora/nuxt`'s `#lunora/app` alias) but
 * never exported. (`nuxt build` succeeds regardless; the gap only surfaces at
 * deploy with "Durable Objects … not exported in your entrypoint file".)
 *
 * This wrapper is the single worker `wrangler.jsonc` points `main` at. It
 * re-exports Nitro's SSR handler as `default` AND the Lunora `ShardDO` class, so
 * the composed worker carries everything Cloudflare needs — Nuxt SSR, the
 * in-worker Lunora plane (`/_lunora/**`, mounted by `@lunora/nuxt`), and the
 * `ShardDO` Durable Object — in one deploy. It's the same "compose one worker"
 * shape the SvelteKit template uses (`src/worker.ts`), just wrapping Nitro's
 * output instead of a hand-written SSR handler.
 *
 * The `.mjs` extension on the Nitro import is required: it's a real emitted file
 * (not TS source), and wrangler/esbuild — not the bundler-resolution TS config —
 * bundles this entry, following the import to `.output/server/index.mjs` and its
 * relative chunks. `.output/` exists at deploy time because the `deploy` script
 * runs `nuxt build` first.
 */
// eslint-disable-next-line import/extensions -- real emitted Nitro output, bundled by wrangler (not bundler-resolution TS)
export { default } from "./.output/server/index.mjs";
export { ShardDO } from "./lunora/server";
