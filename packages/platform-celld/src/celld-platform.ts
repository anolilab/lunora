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
import type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
import { createShardPlatform as createCloudflareShardPlatform, createWorkerPlatform } from "@lunora/platform-cloudflare";

/**
 * Compose every Worker-scoped contract from a celld worker's `env`: the
 * Cloudflare wiring — celld resolves `durable_objects` bindings from the same
 * Wrangler config — under the celld capability matrix.
 */
const createCelldWorkerPlatform = (env: unknown, options: WorkerPlatformOptions = {}): WorkerPlatform => {
    return { ...createWorkerPlatform(env, options), capabilities: CELLD_CAPABILITIES };
};

/**
 * Compose every shard-scoped contract from a celld cell's `DurableObjectState`: the
 * Cloudflare composition without its secret-value host. celld rates `secretValues`
 * unsupported, so the surface is absent rather than present and refusing every call.
 */
export const createCelldShardPlatform = (state: unknown): Omit<ShardPlatform, "secretValues"> => {
    const { kv, shard, sockets } = createCloudflareShardPlatform(state);

    return { kv, shard, sockets };
};

export { createCelldWorkerPlatform };
