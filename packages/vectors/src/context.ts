import { concurrentMap, UPSERT_EMBED_CONCURRENCY } from "./concurrent";
import type { CirrusVectors } from "./types";

/**
 * `(input: string) => vector`. Matches `@cirrus/server`'s `VectorEmbedder` so
 * the bridged surface is assignable to the server's `VectorSearch` contract.
 */
type VectorEmbedderLike = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

interface VectorMatchLike {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

interface VectorMatchesLike {
    count: number;
    matches: ReadonlyArray<VectorMatchLike>;
}

interface VectorRecordLike {
    id: string;
    metadata?: Record<string, unknown>;
    values: ReadonlyArray<number>;
}

interface VectorQueryInputLike {
    embed?: VectorEmbedderLike;
    filter?: Record<string, unknown>;
    input?: string;
    namespace?: string;
    topK?: number;
    vector?: ReadonlyArray<number>;
}

interface VectorUpsertInputLike {
    embed: VectorEmbedderLike;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

/**
 * Structural mirror of `@cirrus/server`'s `VectorSearch`. Declared here so the
 * adapter never imports `@cirrus/server` (keeps the dependency edge one-way:
 * the generated DO depends on both, neither depends on the other).
 */
interface VectorSearchLike {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<void>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorRecordLike>>;
    query: (indexName: string, input: VectorQueryInputLike) => Promise<VectorMatchesLike>;
    upsert: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
    upsertNow: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
}

/**
 * Bridge `CirrusVectors` (returns Vectorize mutation receipts) to the server's
 * `VectorSearch` contract (void mutations, server match/record shapes). Both
 * `upsert` and `upsertNow` write inline — this design has no post-commit queue,
 * so "now" and "deferred" collapse to the same synchronous call.
 */
const createContextVectors = (cirrus: CirrusVectors): VectorSearchLike => {
    const upsert = async (indexName: string, input: VectorUpsertInputLike): Promise<void> => {
        await cirrus.upsert(indexName, {
            embed: input.embed,
            id: input.id,
            input: input.input,
            metadata: input.metadata,
            namespace: input.namespace,
        });
    };

    return {
        deleteByIds: async (indexName: string, ids: ReadonlyArray<string>): Promise<void> => {
            await cirrus.deleteByIds(indexName, ids);
        },
        getByIds: async (indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorRecordLike>> => {
            const records = await cirrus.getByIds(indexName, ids);

            return records.map((record) => {
                return { id: record.id, metadata: record.metadata, values: record.values };
            });
        },
        query: async (indexName: string, input: VectorQueryInputLike): Promise<VectorMatchesLike> => {
            const result = await cirrus.query(indexName, {
                embed: input.embed,
                filter: input.filter,
                input: input.input,
                namespace: input.namespace,
                // Default to "indexed" rather than "all": returning every
                // metadata field by default leaks whatever was stored on the
                // vector (potentially cross-tenant if namespaces aren't wired).
                // Callers that need full metadata opt in explicitly.
                returnMetadata: "indexed",
                topK: input.topK,
                vector: input.vector,
            });

            return {
                count: result.count,
                matches: result.matches.map((match) => {
                    return { id: match.id, metadata: match.metadata, score: match.score };
                }),
            };
        },
        upsert,
        upsertNow: upsert,
    };
};

/** A single row mutation observed by the ctx-db, fed to {@link createVectorSyncHook}. */
interface WriteEvent {
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    table: string;
}

type WriteHook = (event: WriteEvent) => Promise<void>;

/** Inline vector index declared via `.vectorize(field, ...)` (DSL Shape A). */
interface TableVectorIndexLike {
    embed: VectorEmbedderLike;
    field: string;
    metadata?: ReadonlyArray<string>;
    name: string;
}

interface TableDefinitionLike {
    vectorIndexes?: ReadonlyArray<TableVectorIndexLike>;
}

/** Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B). */
interface VectorIndexDefinitionLike {
    embed: VectorEmbedderLike;
    metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    select: (row: Record<string, unknown>) => string;
    table: string;
}

/**
 * Structural mirror of `@cirrus/server`'s `Schema`, narrowed to the fields the
 * sync hook reads. Carries live `embed`/`select` closures, so the hook must be
 * built from the imported `schema` value — never a serialized descriptor.
 */
interface SchemaLike {
    tables: Record<string, TableDefinitionLike>;
    vectorIndexes: Record<string, VectorIndexDefinitionLike>;
}

/**
 * Index names already warned about (metadata synced without a namespace). The
 * warning is a one-time-per-process dev signal, so we dedupe by index name
 * across every hook invocation rather than spamming on every write.
 */
const sharedMetadataWarned = new Set<string>();

/**
 * Emit a single dev warning when an index carrying metadata is synced with no
 * namespace — in a multi-tenant/sharded app that silently shares one tenant's
 * vectors + metadata with every other tenant. Side-effect-only: never touches
 * the upsert payload. At most one warning per index name per process.
 */
const warnSharedMetadata = (indexName: string): void => {
    if (sharedMetadataWarned.has(indexName)) {
        return;
    }

    sharedMetadataWarned.add(indexName);

    // eslint-disable-next-line no-console
    console.warn(
        `[@cirrus/vectors] index "${indexName}" syncs metadata without a namespace — in a\n` +
            "multi-tenant/sharded app this exposes one tenant's vectors+metadata to others.\n" +
            "Pass `namespace` (the shard/tenant key) on both write and query. Suppress via\n" +
            "{ allowSharedMetadata: true }.",
    );
};

const pickMetadata = (row: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
        if (field in row) {
            result[field] = row[field];
        }
    }

    return result;
};

/**
 * Build a {@link WriteHook} that keeps Vectorize in sync with row writes. On
 * insert/update it embeds each matching index's source (Shape A `row[field]`,
 * Shape B `select(row)`) and upserts; on delete it removes the row's id from
 * every index sourced from the table. Runs inline within the write path.
 *
 * Tenant isolation — IMPORTANT: Vectorize indexes are account-global and shared
 * by every shard DO. Without a `namespace`, a multi-tenant sharded app has NO
 * isolation between tenants in the vector index — one tenant's vectors are
 * queryable by another. The caller MUST pass `options.namespace` (the shard /
 * tenant key) so upserts are scoped, and MUST apply the same namespace on the
 * query side. The namespace is threaded onto upserts here; pass it from the
 * shard DO that owns this hook. When it genuinely cannot be supplied, the hook
 * still functions but offers no cross-tenant isolation.
 *
 * Consistency — IMPORTANT: this hook runs inline within the mutation but talks
 * to Vectorize, which is external and non-transactional. The per-index calls
 * fan out; if one fails after others have already applied, the SQLite write may
 * roll back while the applied Vectorize mutations cannot — leaving SQLite and
 * Vectorize diverged. We mitigate, not eliminate: upserts/deletes are
 * idempotent (keyed by row id), so a retry of the same write converges; and on
 * a fan-out failure we attempt a best-effort compensating delete of the row's
 * id from every affected index before re-throwing. A delete after a failed
 * upsert can itself fail — this is best-effort, the authoritative recovery is
 * re-running the (idempotent) write.
 */
const createVectorSyncHook = (options: { allowSharedMetadata?: boolean; namespace?: string; schema: SchemaLike; vectors: VectorSearchLike }): WriteHook => {
    const { allowSharedMetadata, namespace, schema, vectors } = options;

    return async (event: WriteEvent): Promise<void> => {
        const tableDefinition = schema.tables[event.table];
        const inlineIndexes = tableDefinition?.vectorIndexes ?? [];
        const standaloneIndexes = Object.entries(schema.vectorIndexes).filter(([, definition]) => definition.table === event.table);

        if (inlineIndexes.length === 0 && standaloneIndexes.length === 0) {
            return;
        }

        // Every index sourced from this table, by name — used both to fan out
        // deletes and to compensate after a partial upsert failure.
        const allIndexNames = [...inlineIndexes.map((index) => index.name), ...standaloneIndexes.map(([name]) => name)];

        if (event.op === "delete") {
            // Each Vectorize index is independent: a delete on index A can't
            // observe a delete on index B, so the per-index calls run in
            // parallel rather than serially.
            await Promise.all(allIndexNames.map((name) => vectors.deleteByIds(name, [event.id])));

            return;
        }

        const row = event.doc;

        if (!row) {
            return;
        }

        // event.doc on update is the FULL merged row, so an inline (Shape A)
        // index whose source field was just cleared (now nullish) must be
        // PURGED — skipping the upsert would otherwise leave the stale vector
        // searchable. Read each source field once, then split inline indexes
        // into "has a value -> upsert" and "cleared -> delete". Shape B has no
        // per-field source to clear; its `select` defines the value, so it
        // always upserts.
        const inlineWithValue = inlineIndexes.map((index) => {
            return { index, value: row[index.field] };
        });
        const inlineToUpsert = inlineWithValue.filter((entry) => entry.value !== undefined && entry.value !== null);
        const inlineToClear = inlineWithValue.filter((entry) => entry.value === undefined || entry.value === null);

        // The embedder takes text. A non-string source (e.g. a JSON column
        // holding an object/array) would otherwise be coerced via `String()`
        // into "[object Object]"/comma-joined garbage, embedding meaningless
        // text and silently producing an unsearchable vector. Surface it as a
        // descriptive error instead of the silent footgun.
        for (const { index, value } of inlineToUpsert) {
            if (typeof value !== "string") {
                throw new TypeError(
                    `@cirrus/vectors: inline index "${index.name}" expects a string source at "${index.field}" on table "${event.table}" (got ${typeof value}); use a standalone defineVectorIndex with a select() to derive text from non-string columns`,
                );
            }
        }

        // Same per-index independence on the write path — fan the upserts out
        // (plus any clears) and run as a group. Embedders may make remote
        // calls, so the serial loop was a hidden N× latency multiplier. Bound
        // the fan-out with the same cap as `upsertMany`: a table with many
        // vector indexes (or a bulk apply reusing this hook) must not spawn an
        // unbounded number of concurrent embedder + Vectorize subrequests.
        const operations: (() => Promise<void>)[] = [
            ...inlineToClear.map((entry) => async (): Promise<void> => {
                await vectors.deleteByIds(entry.index.name, [event.id]);
            }),
            ...inlineToUpsert.map((entry) => async (): Promise<void> => {
                if (!allowSharedMetadata && namespace === undefined && entry.index.metadata !== undefined && entry.index.metadata.length > 0) {
                    warnSharedMetadata(entry.index.name);
                }

                await vectors.upsert(entry.index.name, {
                    embed: entry.index.embed,
                    id: event.id,
                    input: entry.value as string,
                    metadata: entry.index.metadata ? pickMetadata(row, entry.index.metadata) : undefined,
                    namespace,
                });
            }),
            ...standaloneIndexes.map(([name, definition]) => async (): Promise<void> => {
                if (!allowSharedMetadata && namespace === undefined && definition.metadata !== undefined) {
                    warnSharedMetadata(name);
                }

                await vectors.upsert(name, {
                    embed: definition.embed,
                    id: event.id,
                    input: definition.select(row),
                    metadata: definition.metadata?.(row),
                    namespace,
                });
            }),
        ];

        try {
            await concurrentMap(operations, UPSERT_EMBED_CONCURRENCY, async (operation) => operation());
        } catch (error) {
            // Best-effort compensation: a partial fan-out leaves some indexes
            // mutated. Purge this row's id from every affected index so the
            // diverged state is at least empty rather than stale-but-present,
            // then surface the original failure to the write path.
            await Promise.allSettled(allIndexNames.map((name) => vectors.deleteByIds(name, [event.id])));

            throw error;
        }
    };
};

export type {
    SchemaLike,
    TableDefinitionLike,
    TableVectorIndexLike,
    VectorEmbedderLike,
    VectorIndexDefinitionLike,
    VectorMatchesLike,
    VectorMatchLike,
    VectorQueryInputLike,
    VectorRecordLike,
    VectorSearchLike,
    VectorUpsertInputLike,
    WriteEvent,
    WriteHook,
};
export { createContextVectors, createVectorSyncHook };
