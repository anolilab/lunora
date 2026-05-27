/**
 * Cross-shard query coordinator — *placeholder* for the v0.2 routing layer.
 *
 * Today's runtime resolves a single shard per call via `resolveShard()` and
 * forwards the RPC to that DO directly. That is sufficient for the default
 * `__root__` shard plus any single-key `.shardBy(...)` lookup. It is NOT
 * sufficient for cross-shard queries like:
 *
 *     ctx.db.messages.search("hello")  // -> fan out across N channel shards
 *     ctx.db.messages.list({})         // -> aggregate across shards
 *
 * Those cases need a separate Worker that:
 *   1. Loads the routing table (which shard keys exist for this table) from
 *      durable storage + KV cache.
 *   2. Fans out RPCs in parallel (bounded by `maxConcurrency`).
 *   3. Merges results — concatenation for `list`, score-based merge for
 *      `search`, sum for `count` — and enforces a hard per-shard timeout so
 *      one slow shard cannot stall the response.
 *   4. Streams partial results back over the same WebSocket envelope the
 *      shard-local path uses, so the React hooks do not need to special-case
 *      the cross-shard transport.
 *
 * The plan document calls this out under "Query Coordinator Worker". We
 * ship the entry-point now so downstream packages can wire imports; the
 * implementation lights up automatically once any schema opts into
 * `.shardBy(...)` and codegen emits cross-shard call sites.
 */

export interface QueryCoordinatorOptions {
    /**
     * Maximum number of shard RPCs to issue in parallel. Defaults to 16 once
     * implemented — enough to keep a 30s CPU budget healthy when fanning out
     * to dozens of shards.
     */
    maxConcurrency?: number;
    /**
     * Hard per-shard timeout in milliseconds. Defaults to 5_000 once
     * implemented; a slow shard returns a partial result rather than
     * stalling the aggregate response.
     */
    perShardTimeoutMs?: number;
}

/**
 * @throws Always — the coordinator is intentionally not implemented in v0.1.
 *         Schemas that opt into `.shardBy(...)` will need this to ship in
 *         tandem with the routing table emit (Phase 2).
 */
export const createQueryCoordinator = (_options?: QueryCoordinatorOptions): never => {
    throw new Error(
        "[@cirrus/runtime] cross-shard query coordinator is not implemented yet. "
        + "Schemas that opt into `.shardBy(...)` will require this once Phase 2 ships the routing table.",
    );
};
