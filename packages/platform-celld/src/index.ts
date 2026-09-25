/**
 * `@lunora/platform-celld` — the celld implementation of the
 * `@lunora/platform` host contracts.
 *
 * **Experimental.** celld is a self-hosted, distributed Durable Objects daemon
 * that executes Wrangler bundles, so this package recomposes
 * `@lunora/platform-cloudflare`'s adapters under celld's capability matrix
 * (`CELLD_CAPABILITIES` in `@lunora/platform`, tracking celld v0.5.1) rather
 * than reimplementing the host contracts. `lunora dev` / `lunora deploy` drive
 * `celld dev` / `celld deploy` through `@lunora/config`'s celld driver. See the
 * README.
 */

export { createCelldShardPlatform, createCelldWorkerPlatform } from "./celld-platform";
