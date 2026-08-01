import { resolveDocumentPath } from "../../../../shared/document-path";
import { concurrentMap, UPSERT_EMBED_CONCURRENCY } from "./concurrent";
import type { LunoraVectors, VectorizeVector } from "./types";

/**
 * `(input: string) => vector`. Matches `@lunora/server`'s `VectorEmbedder` so
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
    namespace?: string;
    values: ReadonlyArray<number>;
}

interface VectorQueryInputLike {
    embed?: VectorEmbedderLike;
    filter?: Record<string, unknown>;
    input?: string;
    namespace?: string;

    /**
     * How much stored metadata to return on matches. Defaults to `"indexed"`
     * (only fields declared as index metadata) rather than `"all"`, so a query
     * never leaks arbitrary stored fields by default. Callers that genuinely
     * need every field opt in with `"all"`; pass `"none"` to drop metadata.
     */
    returnMetadata?: "none" | "indexed" | "all";
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
 * Structural mirror of `@lunora/server`'s `VectorSearch`. Declared here so the
 * adapter never imports `@lunora/server` (keeps the dependency edge one-way:
 * the generated DO depends on both, neither depends on the other). `getByIds`/
 * `deleteByIds` carry an optional trailing `namespace` — a pure addition (more
 * general, not narrower) that stays assignable to `@lunora/server`'s
 * `VectorSearchReader`/`VectorSearch`, whose own two-argument signatures are
 * unchanged: a function accepting an extra OPTIONAL parameter is assignable
 * wherever a function taking fewer parameters is expected.
 */
interface VectorSearchLike {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>, namespace?: string) => Promise<void>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>, namespace?: string) => Promise<ReadonlyArray<VectorRecordLike>>;
    query: (indexName: string, input: VectorQueryInputLike) => Promise<VectorMatchesLike>;
    upsert: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
    upsertNow: (indexName: string, input: VectorUpsertInputLike) => Promise<void>;
}

/** Options for {@link createContextVectors}. */
interface CreateContextVectorsOptions {
    /**
     * The DO's own shard/tenant key, applied as the default `namespace` for
     * an operation against an index in `shardedIndexNames` that doesn't pass
     * one explicitly. `undefined` means this instance HAS no shard key —
     * always true for the root/default DO instance, since only a per-tenant
     * instance owns one. See `shardedIndexNames` for what that implies per
     * index, and {@link createContextVectors}'s docblock for the full
     * root-instance rule.
     */
    namespace?: string;

    /**
     * Vector index names sourced from a `.shardBy()`'d table — the ones
     * `namespace` is a meaningful tenant scope for. `ctx.vectors` is a single
     * flat facade over EVERY declared index (root-scoped and sharded tables
     * alike — Vectorize indexes are account-global and `config.vectors(env)`
     * registers them all in one flat map), reachable from ANY DO instance —
     * so `namespace` can only be a safe default for the indexes actually
     * listed here.
     *
     * An index NOT in this set (sourced from a root-scoped table) always
     * stays namespace-less, regardless of `namespace` or which DO instance
     * calls it — it has no tenant identity to begin with, so scoping it would
     * silently return nothing for legitimate, intentionally shared data (and,
     * called from a per-tenant instance, would wrongly search under that
     * tenant's namespace even though nothing was ever written there under
     * it). An index IN this set, called from a per-tenant DO instance
     * (`namespace` is set), defaults to `namespace`, scoping correctly. An
     * index IN this set, called from the root/default DO instance
     * (`namespace` is `undefined`) with no explicit override, is unsafe to
     * default at all — see {@link createContextVectors}'s docblock.
     *
     * Omitted (or empty) → no index is ever treated as sharded, i.e.
     * `namespace` never applies as a default on any call — the unsharded-app,
     * byte-identical-to-today case.
     */
    shardedIndexNames?: ReadonlyArray<string>;
}

/**
 * Bridge `LunoraVectors` (returns Vectorize mutation receipts) to the server's
 * `VectorSearch` contract (void mutations, server match/record shapes). Both
 * `upsert` and `upsertNow` write inline — this design has no post-commit queue,
 * so "now" and "deferred" collapse to the same synchronous call.
 *
 * Tenant isolation (read side) — IMPORTANT: an explicit `namespace` argument
 * on any call (`input.namespace` for `query`/`upsert`/`upsertNow`, the
 * trailing `namespace` parameter for `getByIds`/`deleteByIds`) ALWAYS wins —
 * this is a deliberate soft default, not a hard boundary: `ctx.vectors` is
 * trusted server-side app code (the same trust level that lets `ctx.db` read
 * any table), so a caller that explicitly names a namespace is trusted to
 * mean it, including a legitimate cross-tenant admin read/write. Absent an
 * explicit namespace, `options.namespace` (this DO instance's own shard key)
 * is the DEFAULT for any index in `options.shardedIndexNames` — see that
 * option's docblock for why the default is index-scoped rather than global.
 *
 * Root-instance rule — IMPORTANT: when an operation targets a sharded index
 * (one in `shardedIndexNames`) and BOTH the explicit argument and
 * `options.namespace` are absent (this is the root/default DO instance, which
 * owns no shard key), there is no safe default and no override — this THROWS
 * rather than silently resolving to "no namespace". A namespace-less
 * query/getByIds/deleteByIds/upsert against a sharded index would reach or
 * mutate EVERY tenant's vectors (Vectorize indexes are account-global), which
 * is the exact cross-tenant leak this file exists to close; returning an
 * empty result set instead would masquerade that same configuration problem
 * as "no data", which is worse — a caller debugging it sees nothing rather
 * than a directed error. This case is reachable in a MIXED schema (some
 * vectorized tables `.shardBy()`'d, others root-scoped) whenever application
 * code queries a sharded index's name from the root DO instance without an
 * explicit namespace; it is not reachable from `createVectorSyncHook`'s own
 * internal calls, which only ever process a table this DO instance owns (so
 * a sharded table's write never reaches a root instance in the first place).
 *
 * Id path, unrelated axis — IMPORTANT: independent of the override/root rules
 * above, `getByIds`/`deleteByIds` can't ask Vectorize to filter by namespace
 * remotely at all (its id-based operations take no `namespace` option), so
 * once a namespace IS resolved (explicit or defaulted) for these two methods,
 * isolation is enforced client-side: `getByIds` drops any returned record
 * whose `namespace` doesn't match (fail closed: a record with no `namespace`
 * field is treated as a mismatch, never as "belongs to everyone"), and
 * `deleteByIds` resolves ids via `getByIds` first and only deletes the subset
 * that belongs to the resolved namespace — silently, by design (see the
 * `deleteByIds` implementation for the no-signal tradeoff this makes).
 */
const createContextVectors = (lunora: LunoraVectors, options?: CreateContextVectorsOptions): VectorSearchLike => {
    const defaultNamespace = options?.namespace;
    const shardedIndexNames = new Set(options?.shardedIndexNames);

    const resolveNamespace = (indexName: string, explicit: string | undefined): string | undefined => {
        if (explicit !== undefined) {
            return explicit;
        }

        if (!shardedIndexNames.has(indexName)) {
            return undefined;
        }

        if (defaultNamespace !== undefined) {
            return defaultNamespace;
        }

        throw new Error(
            `@lunora/bindings/vectors: index "${indexName}" belongs to a sharded table, but this DO instance has no shard key (it is the root/default DO) and no explicit namespace was given. A namespace-less operation here would reach every tenant's vectors — Vectorize indexes are account-global. Pass an explicit namespace, or issue this call from the sharded DO instance that owns the tenant.`,
        );
    };

    const upsert = async (indexName: string, input: VectorUpsertInputLike): Promise<void> => {
        await lunora.upsert(indexName, {
            embed: input.embed,
            id: input.id,
            input: input.input,
            metadata: input.metadata,
            namespace: resolveNamespace(indexName, input.namespace),
        });
    };

    // Shared by `getByIds` and `deleteByIds`: fetch the raw records and, when
    // `namespace` is resolved (non-undefined) for this call, keep only the
    // ones whose stored `namespace` matches. Vectorize's id-based operations
    // carry no remote namespace filter, so this is the only enforcement point
    // for the id path. Fail closed on a record with no `namespace` at all —
    // absent is not "belongs to everyone".
    const getMatchingRecords = async (
        indexName: string,
        ids: ReadonlyArray<string>,
        namespace: string | undefined,
    ): Promise<ReadonlyArray<VectorizeVector>> => {
        const records = await lunora.getByIds(indexName, ids);

        if (namespace === undefined) {
            return records;
        }

        return records.filter((record) => record.namespace === namespace);
    };

    return {
        deleteByIds: async (indexName: string, ids: ReadonlyArray<string>, namespace?: string): Promise<void> => {
            const resolved = resolveNamespace(indexName, namespace);

            if (resolved === undefined) {
                await lunora.deleteByIds(indexName, ids);

                return;
            }

            const matching = await getMatchingRecords(indexName, ids, resolved);

            if (matching.length === 0) {
                return;
            }

            await lunora.deleteByIds(
                indexName,
                matching.map((record) => record.id),
            );
        },
        getByIds: async (indexName: string, ids: ReadonlyArray<string>, namespace?: string): Promise<ReadonlyArray<VectorRecordLike>> => {
            const resolved = resolveNamespace(indexName, namespace);
            const records = await getMatchingRecords(indexName, ids, resolved);

            return records.map((record) => {
                return { id: record.id, metadata: record.metadata, namespace: record.namespace, values: record.values };
            });
        },
        query: async (indexName: string, input: VectorQueryInputLike): Promise<VectorMatchesLike> => {
            const result = await lunora.query(indexName, {
                embed: input.embed,
                filter: input.filter,
                input: input.input,
                namespace: resolveNamespace(indexName, input.namespace),
                // Default to "indexed" rather than "all": returning every
                // metadata field by default leaks whatever was stored on the
                // vector (potentially cross-tenant if namespaces aren't wired).
                // Callers that need full metadata opt in explicitly via input.
                returnMetadata: input.returnMetadata ?? "indexed",
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
 * Structural mirror of `@lunora/server`'s `Schema`, narrowed to the fields the
 * sync hook reads. Carries live `embed`/`select` closures, so the hook must be
 * built from the imported `schema` value — never a serialized descriptor.
 */
interface SchemaLike {
    tables: Record<string, TableDefinitionLike>;
    vectorIndexes: Record<string, VectorIndexDefinitionLike>;
}

/**
 * Index names already warned about (synced without a namespace). The warning is
 * a one-time-per-process dev signal, so we dedupe by index name across every
 * hook invocation rather than spamming on every write.
 */
const sharedNamespaceWarned = new Set<string>();

/**
 * Emit a single dev warning when an index is synced with no namespace — in a
 * multi-tenant/sharded app that silently shares one tenant's vectors (and any
 * captured metadata) with every other tenant. The exposure is the vectors
 * themselves, not just metadata: a namespace-less upsert is cross-tenant
 * queryable (ids/scores leak existence + semantic similarity) even when the
 * index carries no metadata, so the warning fires on ANY namespace-less sync,
 * not only when metadata is present. Side-effect-only: never touches the upsert
 * payload. At most one warning per index name per process.
 *
 * Note (plan 255): for a `.shardBy()`'d vectorized table, codegen wires the
 * matching read-side default automatically — the `createContextVectors`
 * instance handed to `ctx.vectors` gets the same shard key as `namespace`,
 * so this warning firing (write side unscoped) implies the read side is
 * unscoped too. It only fires when the app itself constructs an unscoped
 * sync hook (no `.shardBy()`'d table, or a hand-rolled `createVectorSyncHook`
 * call outside codegen).
 */
const warnSharedNamespace = (indexName: string): void => {
    if (sharedNamespaceWarned.has(indexName)) {
        return;
    }

    sharedNamespaceWarned.add(indexName);

    // eslint-disable-next-line no-console
    console.warn(
        `[@lunora/bindings/vectors] index "${indexName}" syncs vectors without a namespace — in a\n` +
            "multi-tenant/sharded app this exposes one tenant's vectors (and any captured\n" +
            "metadata) to every other tenant, since Vectorize indexes are account-global.\n" +
            "Pass `namespace` (the shard/tenant key) on both write and query — query-side\n" +
            "namespace filtering is mandatory for multi-tenant apps. Single-tenant apps that\n" +
            "legitimately have no tenant key suppress this via { allowSharedNamespace: true }.",
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
 * queryable by another (ids/scores leak existence + semantic similarity even
 * when no metadata is indexed). The caller MUST pass `options.namespace` (the
 * shard / tenant key) so upserts are scoped, and MUST apply the same namespace
 * on the query side — query-side namespace filtering is mandatory, not optional.
 * The namespace is threaded onto upserts here; pass it from the shard DO that
 * owns this hook. Any namespace-less sync emits a one-time-per-index dev warning
 * (regardless of whether metadata is present); a genuinely single-tenant app
 * suppresses it with `allowSharedNamespace: true`.
 *
 * Since plan 255, codegen satisfies the query-side requirement automatically
 * for a `.shardBy()`'d vectorized table: the `vectors` instance passed in
 * `options` here is the SAME `createContextVectors(...)` instance exposed as
 * `ctx.vectors`, constructed with the identical shard-key `namespace` default
 * AND the identical `shardedIndexNames` — so `ctx.vectors.query`/`getByIds`/
 * `deleteByIds` are scoped without any app code changes. One consequence of
 * sharing that instance: this hook's own internal `deleteByIds` calls (on row
 * delete, on a cleared inline field, and on compensation after a failed
 * upsert) now also go through the namespace-verifying path described on
 * {@link createContextVectors} — an extra `getByIds` subrequest per
 * delete-shaped write, not a behavior change (the row being deleted was
 * written under this same shard's namespace, so the verification passes).
 * This never hits {@link createContextVectors}'s root-instance throw: a write
 * event only ever fires for a table THIS DO instance owns, so if this hook
 * processes a write for a sharded index, this instance IS a real per-tenant
 * shard (not root) — `namespace` here is never `undefined` for that index.
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
const createVectorSyncHook = (options: { allowSharedNamespace?: boolean; namespace?: string; schema: SchemaLike; vectors: VectorSearchLike }): WriteHook => {
    const { allowSharedNamespace, namespace, schema, vectors } = options;

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
            return { index, value: resolveDocumentPath(row, index.field) };
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
                    `@lunora/bindings/vectors: inline index "${index.name}" expects a string source at "${index.field}" on table "${event.table}" (got ${typeof value}); use a standalone defineVectorIndex with a select() to derive text from non-string columns`,
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
                if (!allowSharedNamespace && namespace === undefined) {
                    warnSharedNamespace(entry.index.name);
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
                if (!allowSharedNamespace && namespace === undefined) {
                    warnSharedNamespace(name);
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
    CreateContextVectorsOptions,
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
