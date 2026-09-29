import { renderThrowingStub } from "./shard-bindings";

/**
 * The emitted ShardDO's Vectorize wiring: the `ctx.vectors` stub and build, and
 * the `vectorSync` adapter method shared by the auto-sync write hook and the
 * `backfillVectors` override. Split out of `emitShard`; all three are empty
 * without a vector index. `shardedIndexNames` lists the indexes owned by a
 * `.shardBy()`'d table, and the tenant namespacing only appears when it is
 * non-empty.
 */
const emitVectorFragments = (
    hasVectorIndexes: boolean,
    shardedIndexNames: ReadonlyArray<string>,
): { vectorsBuild: string; vectorsStub: string; vectorSyncMethod: string } => {
    const hasShardedVectors = shardedIndexNames.length > 0;
    const vectorsMissing = `throw new Error("ctx.vectors: no vectors configured. Pass \`vectors\` to createShardDO().");`;
    const vectorsStub = hasVectorIndexes
        ? renderThrowingStub("vectorsStub: VectorSearchLike", vectorsMissing, ["deleteByIds", "getByIds", "query", "upsert", "upsertNow"])
        : "";

    // Vectorize indexes are account-global — a `.shardBy()` table's auto-sync
    // must scope upserts by this DO's own shard key (its tenant identity), or
    // every tenant's vectors land in one shared, unpartitioned namespace.
    // `currentShardKey()` returns the real key for a per-tenant DO instance and
    // the `ROOT_SHARD_NAME` sentinel for the single default DO, so mapping the
    // sentinel back to `undefined` keeps a root-mode write on this same schema
    // (e.g. a mixed app where only SOME vectorized tables are `.shardBy()`)
    // namespace-less, same as today. Gated on `hasShardedVectors` so a schema
    // with no `.shardBy()`'d vector table emits the bare call, unchanged.
    const vectorNamespaceField = hasShardedVectors ? "            const vectorShardKey = this.currentShardKey();\n" : "";
    const vectorNamespaceOption = hasShardedVectors ? "namespace: vectorShardKey === ROOT_SHARD_NAME ? undefined : vectorShardKey, " : "";
    // Read-side counterpart to `vectorNamespaceOption`: threaded into
    // `createContextVectors` so `ctx.vectors` (query/getByIds/deleteByIds/
    // upsert/upsertNow) defaults to this DO's own namespace too — otherwise
    // `ctx.vectors.query` searches every tenant's vectors (namespace-less
    // Vectorize queries match the whole index) even though the auto-sync
    // write hook above is already scoped.
    //
    // This does NOT simply mirror `vectorNamespaceOption`'s sentinel mapping,
    // for a reason specific to the read side: `ctx.vectors` is a single flat
    // facade over EVERY declared vector index (root-scoped and sharded tables
    // alike — `config.vectors(env)` registers them all in one map), reachable
    // from ANY DO instance. The write hook is safe to map `ROOT_SHARD_NAME` to
    // `undefined` unconditionally because a write event only ever fires for a
    // table THIS instance owns (a sharded table's rows never reach the root
    // instance) — but a read/explicit-write call takes an arbitrary index name
    // from application code, so the SAME mapping on `ctx.vectors` would let a
    // namespace-less call from the root instance reach a SHARDED index and
    // search/mutate every tenant's vectors, in a mixed schema (some vectorized
    // tables `.shardBy()`'d, others root-scoped). `shardedIndexNames` tells the
    // adapter exactly which indexes `namespace` is a valid default for, so a
    // root-instance call against a genuinely root-scoped index stays
    // namespace-less (correct — unchanged), while the same call against a
    // sharded index throws (see `createContextVectors`'s docblock) rather than
    // silently defaulting to "every tenant". The two namespace keys are gated on
    // `hasShardedVectors` so an unsharded (or no-vectors) schema carries neither.
    //
    // `deferAfterCommit` is emitted unconditionally, sharded or not: it is what
    // makes `ctx.vectors.upsert` mean what `MutationCtx` documents it to mean —
    // held until the mutation's transaction COMMITS, so a handler that upserts a
    // vector and then throws does not leave one behind for a row that was rolled
    // back. `upsertNow` keeps writing inline, which is the distinction the two
    // names carry. Same host primitive the auto-sync hook goes through below, so
    // a manual upsert and the hook it sits next to drain in one ordered queue.
    const vectorsContextOptions = [
        "deferAfterCommit: (work) => this.deferAfterCommit(work)",
        ...(hasShardedVectors
            ? [
                  "namespace: vectorShardKey === ROOT_SHARD_NAME ? undefined : vectorShardKey",
                  `shardedIndexNames: [${shardedIndexNames.map((name) => JSON.stringify(name)).join(", ")}]`,
              ]
            : []),
    ];
    const vectorsContextOption = `, { ${vectorsContextOptions.join(", ")} }`;
    const vectorsBuild = hasVectorIndexes
        ? `
            const vectorSync = this.vectorSync(env);
            // Vectorize lives outside this shard's SQLite, so a query whose result
            // depends on a similarity search cannot be proven current on reconnect —
            // an unrelated upsert (or a re-index) moves the matches without touching
            // \`__cdc_log\`. Only \`ctx.vectors\` is wrapped: the write-through
            // vector-sync hook keeps calling the bare facade.
            const bareVectors = vectorSync?.vectors ?? vectorsStub;
            const vectors = markUnvouchableReads(bareVectors, options.onRead, ["getByIds", "query"]);
            const onWrite = vectorSync?.onWrite;
`
        : "";

    // The one place the Vectorize adapters are assembled: `ctx.vectors` and its
    // write-through hook for `buildCtx`, and the batched page sync for the
    // `backfillVectors` override below — so the namespace scoping of all three
    // cannot drift apart. `undefined` when the app configured no `vectors`.
    const vectorSyncMethod = hasVectorIndexes
        ? `
        private vectorSync(env: Record<string, unknown>): { backfill: VectorBackfillSync; onWrite: WriteHook; vectors: VectorSearchLike } | undefined {
            if (!config.vectors) {
                return undefined;
            }

            const lunora = createVectors({ indexes: config.vectors(env) });
${vectorNamespaceField}            const vectors = createContextVectors(lunora${vectorsContextOption});

            return {
                backfill: createVectorBackfillSync({ ${vectorNamespaceOption}schema: schema as unknown as VectorSchemaLike, upsertMany: lunora.upsertMany, vectors }),
                onWrite: createVectorSyncHook({ ${vectorNamespaceOption}schema: schema as unknown as VectorSchemaLike, vectors }),
                vectors,
            };
        }

        // \`__lunora_admin__:backfillVectors\`: the rows that predate a vector index,
        // a page at a time, each page ordered on the after-commit chain so it
        // never lands over a newer write's vector.
        protected override async runShardVectorBackfill(options: { maxPages?: number; restart?: boolean }): Promise<VectorBackfillProgress> {
            this.ensureMigrated();

            const vectorSync = this.vectorSync((this.env ?? {}) as Record<string, unknown>);

            if (!vectorSync) {
                throw new LunoraError("NOT_IMPLEMENTED", "vector backfill is unavailable: no vectors configured. Pass \`vectors\` to createShardDO().");
            }

            return backfillVectorIndexes(this.sql as SqlExec, vectorBackfillTargets(schema as unknown as VectorSchemaLike), vectorSync.backfill, {
                ...options,
                ordered: async (read, work) => this.runOrderedAfterWrites(read, work),
            });
        }
`
        : "";

    return { vectorSyncMethod, vectorsBuild, vectorsStub };
};

export default emitVectorFragments;
