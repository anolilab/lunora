/**
 * One shard's observed traffic share — the input the `hot_shard` runtime lint
 * consumes. Produced by the studio backend, which fans out over a sharded
 * function's shards and reads each shard's recorded request volume from the
 * durable `__lunora_metrics` accumulator (`SUM(calls)`) — or, equivalently, the
 * per-shard request-log count. Codegen and other static callers don't supply
 * it, so the lint simply finds nothing there.
 *
 * The lint is a pure function over its context, so it can't fan out over shards
 * itself; the caller does the cross-shard read and hands the aggregated
 * distribution here, exactly as the codegen feeder hands `AdvisorQueryRead`s for
 * the static query lints.
 */
export interface AdvisorShardTraffic {
    /**
     * The sharded function group these shards belong to, when the caller scopes
     * the distribution to one `.shardBy(...)` function. Used only to name the
     * finding; empty when the traffic is the whole deployment's shard set.
     */
    group?: string;
    /** Total requests (function dispatches) recorded against this shard over the observed window. */
    requests: number;

    /**
     * The shard key (the Durable Object id name) traffic was attributed to —
     * a user / tenant / room id, depending on the `.shardBy(...)` key. Empty for
     * the unnamed root DO.
     */
    shardKey: string;
}
