/**
 * `@lunora/platform-cloudflare` — the Cloudflare implementation of the
 * `@lunora/platform` contracts.
 *
 * `@lunora/platform` says what a host must provide; this says how Cloudflare
 * provides it, over `DurableObjectState`, hibernatable WebSockets, and a
 * `DurableObjectNamespace`. A second target ships the same surface from its own
 * `@lunora/platform-&lt;target>` package, so adding one is a sibling rather than a
 * refactor of `@lunora/do`.
 *
 * # Why this depends on nothing but the contracts
 *
 * An earlier version of this package sat *above* `@lunora/do` — it composed
 * adapters that lived there, and so depended on the very package it was meant
 * to make replaceable. That inverts the end-state, and with one host it also
 * had zero consumers, so it was dissolved. This version is the other way up:
 * the adapters live here, `@lunora/do` depends on this, and the only imports
 * are `@lunora/platform` plus Cloudflare's own types. That is what makes the
 * seam real rather than aspirational — `@lunora/do` can no longer reach a
 * provider API except through a contract.
 */

export { createShardAlarms, createShardDirectory, createShardHost, createShardKvStore, createSocketHost } from "./cloudflare-host";
export type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "./platform";
export { createShardPlatform, createWorkerPlatform } from "./platform";
