/**
 * DO-side helpers for the batch RPC transport (plan 088). Extracted from
 * `shard-do.ts` (a very large file) as a cohesive, `this`-free unit: turning a
 * forwarded {@link BatchEntry} into the synthetic single-call `/rpc` request the
 * DO replays through its existing dispatch core. `shard-do.ts`'s `handleBatchRpc`
 * owns the (stateful) `this.fetch` loop; the pure request-shaping lives here.
 */

import type { BatchEntry } from "../../../shared/batch-wire";

/**
 * Header names copied verbatim from the batch request onto each per-entry `/rpc`
 * request — identity/bookmark/routing are shared by the whole batch (one
 * authenticated request), so they ride the outer request; per-entry
 * mutation/client-seq headers come off each {@link BatchEntry}.
 */
const SHARED_BATCH_HEADERS = [
    "x-lunora-userid",
    "x-lunora-identity",
    "x-d1-bookmark",
    "x-lunora-client-ip",
    "x-lunora-system",
    "x-lunora-shard-binding",
] as const;

/**
 * Build the synthetic single-call `/rpc` request for one batch entry: the shared
 * identity/bookmark headers off the batch request plus this entry's own
 * mutation/client-seq headers, and `{ args, functionPath }` as the body. Feeding
 * it back through `ShardDO.fetch` reuses the exact single-call dispatch (so
 * idempotency + watermark ordering are inherited, not re-implemented).
 */
const buildBatchEntryRequest = (batchRequest: Request, entry: BatchEntry): Request => {
    const headers = new Headers({ "content-type": "application/json" });

    for (const name of SHARED_BATCH_HEADERS) {
        const value = batchRequest.headers.get(name);

        if (value !== null) {
            headers.set(name, value);
        }
    }

    if (entry.mutationId !== undefined) {
        headers.set("x-lunora-mutation-id", entry.mutationId);
    }

    if (entry.clientId !== undefined) {
        headers.set("x-lunora-client-id", entry.clientId);
    }

    if (entry.clientSeq !== undefined) {
        headers.set("x-lunora-client-seq", String(entry.clientSeq));
    }

    return new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: entry.args ?? {}, functionPath: entry.functionPath }),
        headers,
        method: "POST",
    });
};

export { buildBatchEntryRequest, SHARED_BATCH_HEADERS };
