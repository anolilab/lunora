/**
 * Shared wire contract for the batch RPC transport (plan 088), bundler-inlined
 * (like {@link file://./wire-codec.ts}) so the worker (`@lunora/runtime`, which
 * groups + forwards) and the Durable Object (`@lunora/do`, which receives)
 * describe a batch entry with ONE type instead of two drifting mirrors.
 *
 * Keep this genuinely zero-dependency (types + a constant only).
 */

/**
 * One entry of a `/_lunora/rpc-batch` request, as forwarded from the worker to a
 * shard DO. `id` is the caller-assigned index used to demux results back in
 * input order; `shardKey` is NOT carried here — the worker consumes it to route
 * and groups entries by it, so a forwarded entry already belongs to one shard.
 */
interface BatchEntry {
    args?: Record<string, unknown>;

    /**
     * The CDC cursor this write was composed at, forwarded as `x-lunora-base-seq`
     * on the entry's synthetic `/rpc` request. PER ENTRY, not on the outer batch
     * request: a batch carries writes composed at different cursors, and one
     * outbound header cannot state a baseline for all of them. Omitted when the
     * write was composed with no baseline, which applies it unchanged.
     */
    baselineSeq?: number;

    clientId?: string;
    clientSeq?: number;
    functionPath: string;
    id: number;
    mutationId?: string;
}

/**
 * Hard cap on entries in a single batch. A Durable Object is single-threaded and
 * replays batch entries sequentially, so an unbounded batch (bounded only by the
 * request body size) could pin a shard for tens of thousands of dispatches. 500
 * matches the repo's other batch ceiling (plan 053's `insertMany`/`deleteMany`);
 * a client with a larger offline outbox chunks its flush.
 */
const MAX_BATCH_ENTRIES = 500;

export type { BatchEntry };
export { MAX_BATCH_ENTRIES };
