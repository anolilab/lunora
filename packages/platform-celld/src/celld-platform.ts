/**
 * The celld composition roots.
 *
 * celld (github.com/denoland/celld) is a self-hosted, distributed Durable
 * Objects daemon: each node embeds V8, executes Wrangler bundles, and
 * coordinates cell ownership through an S3-compatible bucket. Because it
 * implements the Workers/Durable Object API itself — `DurableObjectState`
 * key-value storage, alarms, the hibernation WebSocket surface, namespaces
 * with `idFromName` and RPC stubs — the Cloudflare adapters in
 * `@lunora/platform-cloudflare` ARE the celld adapters. This module does not
 * reimplement them; it recomposes them with what actually differs:
 *
 * 1. **The capability matrix.** `createWorkerPlatform` hardcodes
 * `CLOUDFLARE_CAPABILITIES`; on celld the honest matrix is
 * `CELLD_CAPABILITIES` (no KV/R2/D1/queues bindings, no managed platform
 * services, no cron triggers — see its docstring in `@lunora/platform`).
 *
 * 2. **`state.storage.sql` does not exist.** celld persists each cell in its
 * own SQLite database but exposes no SQL API to the isolate (a D1-compatible
 * surface is planned). The Cloudflare adapter's call-time probe would surface
 * that as a bare `TypeError`; the guard here names the target, the rating,
 * and the reason instead, because "localSql is unsupported on celld" is a
 * platform gap, not a broken test double. The probe stays call-time so the
 * same code delegates transparently the day celld ships the surface.
 *
 * The Cloudflare adapters are already defensive about optional primitives
 * (call-time probes, degradation for doubles), which is what makes this
 * recomposition safe on celld's real gaps: no `getTags` means socket ids fall
 * back to accept-time bookkeeping — sound on celld, where a cell with live
 * sockets is never evicted — and a missing `blockConcurrencyWhile` or
 * `storage.transaction` degrades to a bare call.
 */

import type { ShardSqlExec } from "@lunora/platform";
import { CELLD_CAPABILITIES } from "@lunora/platform";
import type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
import { createShardPlatform, createWorkerPlatform } from "@lunora/platform-cloudflare";

/**
 * Whether the state actually carries a `storage.sql.exec` — `false` on celld
 * today, `true` once celld ships its planned D1-compatible surface (or when a
 * test double provides one). Probed per call, mirroring the Cloudflare
 * adapter's own call-time resolution, so the answer tracks the host rather
 * than construction order.
 */
const hasLocalSql = (state: unknown): boolean => {
    const storage = (state as { storage?: { sql?: { exec?: unknown } } } | null | undefined)?.storage;

    return typeof storage?.sql?.exec === "function";
};

/**
 * Compose every shard-scoped contract from a celld cell's
 * `DurableObjectState`, by delegating to the Cloudflare adapters and wrapping
 * the one primitive celld does not provide. See the module docstring for why
 * delegation is correct here.
 */
export const createCelldShardPlatform = (state: unknown): ShardPlatform => {
    const platform = createShardPlatform(state);

    const sql: ShardSqlExec = {
        get databaseSize(): number | undefined {
            return platform.shard.sql.databaseSize;
        },
        exec: (query, ...bindings) => {
            if (hasLocalSql(state)) {
                return platform.shard.sql.exec(query, ...bindings) as never;
            }

            throw new Error(
                '@lunora/platform-celld: celld does not implement state.storage.sql — "localSql" is rated unsupported in CELLD_CAPABILITIES ' +
                    "(celld plans a D1-compatible SQL surface). The Lunora shard engine cannot mount on this target until it ships.",
            );
        },
    };

    return { ...platform, shard: { ...platform.shard, sql } };
};

/**
 * Compose every Worker-scoped contract from a celld worker's `env`. Identical
 * wiring to Cloudflare's — celld resolves `durable_objects` bindings from the
 * same Wrangler config, so the directory lookup and its missing-binding error
 * apply verbatim — under the celld capability matrix.
 */
export const createCelldWorkerPlatform = (env: unknown, options: WorkerPlatformOptions = {}): WorkerPlatform => {
    return { ...createWorkerPlatform(env, options), capabilities: CELLD_CAPABILITIES };
};
