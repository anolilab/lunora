/**
 * `@lunora/platform-celld` — the celld implementation of the
 * `@lunora/platform` host contracts.
 *
 * **Spike.** celld is a self-hosted, distributed Durable Objects daemon that
 * executes Wrangler bundles, so this package is a recomposition of
 * `@lunora/platform-cloudflare`'s adapters under celld's honest capability
 * matrix (`CELLD_CAPABILITIES` in `@lunora/platform`) plus a guard for the
 * one primitive celld lacks (`state.storage.sql`). Not wired into
 * `lunora dev`; no deploy driver; blocked as a runnable target on celld's
 * planned D1-compatible SQL surface — see the README.
 */

export { createCelldShardPlatform, createCelldWorkerPlatform } from "./celld-platform";
