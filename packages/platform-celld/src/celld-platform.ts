/**
 * The celld composition roots.
 *
 * celld (github.com/denoland/celld) is a self-hosted, distributed Durable
 * Objects daemon: each node embeds V8, executes Wrangler bundles, and
 * coordinates cell ownership through an S3-compatible bucket. Because it
 * implements the Workers/Durable Object API itself — `DurableObjectState`
 * key-value storage, `state.storage.sql`, alarms, the hibernation WebSocket
 * surface, namespaces with `idFromName` and RPC stubs — the Cloudflare
 * adapters in `@lunora/platform-cloudflare` ARE the celld adapters. This
 * module does not reimplement them; the only thing that genuinely differs is
 * the capability matrix.
 *
 * `createWorkerPlatform` hardcodes `CLOUDFLARE_CAPABILITIES`; on celld the
 * honest matrix is `CELLD_CAPABILITIES` (no Workers AI / Vectorize /
 * Containers / Hyperdrive / Secrets Store bindings, no Cache API, no cell
 * placement, and no usable Queues consumer — see its docstring in
 * `@lunora/platform` for why each). Swapping it is the whole package.
 *
 * The shard root needs no wrapper at all as of celld v0.4.0. Until v0.3.0
 * celld exposed no `state.storage.sql` to the isolate, so this module guarded
 * `sql.exec` behind a call-time probe that threw an error naming the target
 * and the rating rather than letting a bare `TypeError` escape. celld ships
 * the surface now, `localSql` is rated `native`, and the guard is gone — the
 * Cloudflare adapter mounts on a cell unchanged.
 *
 * Those adapters are already defensive about optional primitives (call-time
 * probes, degradation for doubles), which covers celld's remaining gaps: no
 * `getTags` means socket ids fall back to accept-time bookkeeping — sound on
 * celld, where a cell holding a live socket is never shed — and a missing
 * `blockConcurrencyWhile` or `storage.transaction` degrades to a bare call.
 */

import { CELLD_CAPABILITIES } from "@lunora/platform";
import type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
import { createShardPlatform, createWorkerPlatform } from "@lunora/platform-cloudflare";

/**
 * Compose every shard-scoped contract from a celld cell's
 * `DurableObjectState`. celld implements the Durable Object primitives the
 * Cloudflare adapters resolve, so this IS `createShardPlatform` — named
 * separately so a celld app's composition root reads like its target and so
 * the seam exists if celld's cell surface ever diverges.
 */
export const createCelldShardPlatform = (state: unknown): ShardPlatform => createShardPlatform(state);

/**
 * Compose every Worker-scoped contract from a celld worker's `env`. Identical
 * wiring to Cloudflare's — celld resolves `durable_objects` bindings from the
 * same Wrangler config, so the directory lookup and its missing-binding error
 * apply verbatim — under the celld capability matrix.
 */
export const createCelldWorkerPlatform = (env: unknown, options: WorkerPlatformOptions = {}): WorkerPlatform => {
    return { ...createWorkerPlatform(env, options), capabilities: CELLD_CAPABILITIES };
};
