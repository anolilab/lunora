/**
 * `@lunora/platform-celld` — the celld implementation of the
 * `@lunora/platform` host contracts.
 *
 * **Experimental.** celld is a self-hosted, distributed Durable Objects daemon
 * that executes Wrangler bundles, so this package is a recomposition of
 * `@lunora/platform-cloudflare`'s adapters under celld's honest capability
 * matrix (`CELLD_CAPABILITIES` in `@lunora/platform`, tracking celld v0.4.0)
 * rather than a second implementation of the five contracts. Not wired into
 * `lunora dev` and no `@lunora/config` deploy driver — celld apps deploy
 * through `celld deploy`. See the README.
 */

export { createCelldShardPlatform, createCelldWorkerPlatform } from "./celld-platform";
