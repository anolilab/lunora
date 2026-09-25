/**
 * The celld composition roots.
 *
 * celld (github.com/denoland/celld) implements the Workers/Durable Object API
 * itself — `DurableObjectState` key-value storage, `state.storage.sql`,
 * alarms, the hibernation WebSocket surface (including `getTags`), namespaces
 * with `idFromName` and RPC stubs — so the Cloudflare adapters in
 * `@lunora/platform-cloudflare` are the celld adapters, unchanged. The one
 * thing that differs is the capability matrix: `createWorkerPlatform` reports
 * `CLOUDFLARE_CAPABILITIES`, and on celld the honest matrix is
 * `CELLD_CAPABILITIES` (see its docstring in `@lunora/platform`).
 */

import { CELLD_CAPABILITIES } from "@lunora/platform";
import type { WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
import { createWorkerPlatform } from "@lunora/platform-cloudflare";

/**
 * Compose every Worker-scoped contract from a celld worker's `env`: the
 * Cloudflare wiring — celld resolves `durable_objects` bindings from the same
 * Wrangler config — under the celld capability matrix.
 */
const createCelldWorkerPlatform = (env: unknown, options: WorkerPlatformOptions = {}): WorkerPlatform => {
    return { ...createWorkerPlatform(env, options), capabilities: CELLD_CAPABILITIES };
};

export { createCelldWorkerPlatform };

/**
 * Compose every shard-scoped contract from a celld cell's `DurableObjectState`.
 * The Cloudflare composition root as-is, re-exported under the target's name
 * so a celld app's composition root reads like its target.
 */
export { createShardPlatform as createCelldShardPlatform } from "@lunora/platform-cloudflare";
