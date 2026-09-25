import { LunoraError } from "@lunora/errors";

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
     * Hold `upsert`'s remote write until the caller's storage transaction has
     * COMMITTED, running it at once when none is open. The shard host supplies
     * `ShardDO.deferAfterCommit`; codegen wires it.
     *
     * This is what separates `upsert` from `upsertNow`. Vectorize is outside the
     * shard's SQLite and cannot roll back, so an inline `ctx.vectors.upsert` in a
     * mutation that later throws leaves a vector pointing at a row that does not
     * exist — and a search surfaces it. Omitted, both methods write inline, which
     * is correct for a caller that has no transaction to wait for (an action, a
     * test, the `@lunora/ai` RAG helpers).
     */
    deferAfterCommit?: (work: () => Promise<void>) => Promise<void>;

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
 * `VectorSearch` contract (void mutations, server match/record shapes).
 *
 * `upsert` vs `upsertNow` — IMPORTANT: with `options.deferAfterCommit` supplied
 * (codegen wires the shard host's), `upsert` holds the remote write until the
 * caller's transaction has committed and `upsertNow` writes inline, which is
 * what `MutationCtx`'s contract documents. Without it both write inline: a
 * caller with no transaction open has nothing to wait for. The NAMESPACE is
 * resolved eagerly either way — before the deferral, not inside it — so a
 * misconfiguration (the root-instance throw below) still reaches the handler
 * that made the call instead of a post-commit log line nobody is holding.
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

    const deferAfterCommit = options?.deferAfterCommit;

    const write = async (indexName: string, input: VectorUpsertInputLike, namespace: string | undefined): Promise<void> => {
        await lunora.upsert(indexName, {
            embed: input.embed,
            id: input.id,
            input: input.input,
            metadata: input.metadata,
            namespace,
        });
    };

    const upsertNow = async (indexName: string, input: VectorUpsertInputLike): Promise<void> => {
        await write(indexName, input, resolveNamespace(indexName, input.namespace));
    };

    const upsert =
        deferAfterCommit === undefined
            ? upsertNow
            : async (indexName: string, input: VectorUpsertInputLike): Promise<void> => {
                  // Resolved HERE, not in the deferred closure: `resolveNamespace`
                  // throws for a sharded index reached from the root instance, and
                  // that error belongs to the handler that made the call — thrown
                  // after the commit it is only a log line.
                  const namespace = resolveNamespace(indexName, input.namespace);

                  await deferAfterCommit(async () => write(indexName, input, namespace));
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
                // `Array.from`: the binding's own `values` may be a typed array
                // (`VectorValues`), and `VectorRecordLike` — the ctx-facing shape — is
                // a plain number array.
                return { id: record.id, metadata: record.metadata, namespace: record.namespace, values: [...record.values] };
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
        upsertNow,
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
    dimensions?: number;
    embed: VectorEmbedderLike;
    field: string;
    metadata?: ReadonlyArray<string>;
    metric?: string;
    /** Declared identifier of what `embed` produces; part of the backfill fingerprint. */
    model?: string;
    name: string;
}

interface TableDefinitionLike {
    /** `.softDelete()` marker column. A row whose marker is set is hidden from `ctx.db`, so it must have no vector. */
    softDeleteMode?: { field: string };
    vectorIndexes?: ReadonlyArray<TableVectorIndexLike>;
}

/** Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B). */
interface VectorIndexDefinitionLike {
    dimensions?: number;
    embed: VectorEmbedderLike;
    metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    metric?: string;
    /** Declared identifier of what `embed` produces; part of the backfill fingerprint. */
    model?: string;
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

/** One index's upsert for a row, with the source text already resolved. */
interface PlannedUpsert {
    embed: VectorEmbedderLike;
    input: string;
    metadata?: Record<string, unknown>;
    name: string;
}

/** What a row write means for every index sourced from its table. */
interface RowSyncPlan {
    /** Index names the row's vector must be removed from. */
    deletes: string[];
    upserts: PlannedUpsert[];
}

/**
 * Queue `upsert` — or, when its text is blank (empty or whitespace only), the
 * purge of the row's vector from that index: there is nothing to embed.
 */
const place = (plan: RowSyncPlan, upsert: PlannedUpsert): void => {
    if (upsert.input.trim() === "") {
        plan.deletes.push(upsert.name);
    } else {
        plan.upserts.push(upsert);
    }
};

/** A Shape A index's source text, or `undefined` when the field is nullish. */
const inlineSource = (row: Record<string, unknown>, index: TableVectorIndexLike, table: string): string | undefined => {
    const value = resolveDocumentPath(row, index.field);

    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new TypeError(
            `@lunora/bindings/vectors: inline index "${index.name}" expects a string source at "${index.field}" on table "${table}" (got ${typeof value}); use a standalone defineVectorIndex with a select() to derive text from non-string columns`,
        );
    }

    return value;
};

/**
 * Decide what one row write means for its vector indexes — shared by the live
 * write hook and the backfill, so the two cannot disagree about which rows have
 * a vector. `undefined` when no index is sourced from the table (or an update
 * carries no document).
 *
 * Throws a `TypeError` for an inline index whose source is not a string: the
 * embedder takes text, and a JSON column coerced through `String()` would embed
 * "[object Object]" — an unsearchable vector with no error anywhere.
 */
const planRowSync = (schema: SchemaLike, event: WriteEvent): RowSyncPlan | undefined => {
    const tableDefinition = schema.tables[event.table];
    const inlineIndexes = tableDefinition?.vectorIndexes ?? [];
    const standaloneIndexes = Object.entries(schema.vectorIndexes).filter(([, definition]) => definition.table === event.table);

    if (inlineIndexes.length === 0 && standaloneIndexes.length === 0) {
        return undefined;
    }

    // A soft-deleted row is hidden from `ctx.db`, so it must not be findable
    // through its vector either — `query` would hand back its id and metadata.
    // Soft delete itself arrives as `op: "delete"`, but the row stays writable:
    // a later `patch`/`replace` arrives as `update` carrying the still-set
    // marker, and upserting it would put the hidden row back into search. So
    // decide from the ROW, not the op: any write that leaves the marker set is
    // a delete, whichever order the writes come in. `restore()` clears the
    // marker, which is what re-embeds it.
    const softField = tableDefinition?.softDeleteMode?.field;
    const hidden = softField !== undefined && event.doc?.[softField] !== undefined && event.doc[softField] !== null;

    if (event.op === "delete" || hidden) {
        return { deletes: [...inlineIndexes.map((index) => index.name), ...standaloneIndexes.map(([name]) => name)], upserts: [] };
    }

    const row = event.doc;

    if (!row) {
        return undefined;
    }

    const plan: RowSyncPlan = { deletes: [], upserts: [] };

    // event.doc on update is the FULL merged row, so an inline (Shape A) index
    // whose source field was just cleared (now nullish) must be PURGED —
    // skipping the upsert would leave the stale vector searchable. Shape B has
    // no per-field source to clear; its `select` defines the value.
    //
    // Blank text (empty or whitespace only) is a delete too, for both shapes:
    // there is nothing to embed, and an embedder refuses it on every attempt —
    // which, across a whole page of such rows, reads as the service being down.
    for (const index of inlineIndexes) {
        const input = inlineSource(row, index, event.table);

        if (input === undefined) {
            plan.deletes.push(index.name);
        } else {
            place(plan, { embed: index.embed, input, metadata: index.metadata ? pickMetadata(row, index.metadata) : undefined, name: index.name });
        }
    }

    for (const [name, definition] of standaloneIndexes) {
        place(plan, { embed: definition.embed, input: definition.select(row), metadata: definition.metadata?.(row), name });
    }

    return plan;
};

/**
 * Build a {@link WriteHook} that keeps Vectorize in sync with row writes. On
 * insert/update it embeds each matching index's source (Shape A `row[field]`,
 * Shape B `select(row)`) and upserts; on delete it removes the row's id from
 * every index sourced from the table. {@link planRowSync} makes the decision.
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
 * delete and on a cleared inline field) now also go through the
 * namespace-verifying path described on
 * {@link createContextVectors} — an extra `getByIds` subrequest per
 * delete-shaped write, not a behavior change (the row being deleted was
 * written under this same shard's namespace, so the verification passes).
 * This never hits {@link createContextVectors}'s root-instance throw: a write
 * event only ever fires for a table THIS DO instance owns, so if this hook
 * processes a write for a sharded index, this instance IS a real per-tenant
 * shard (not root) — `namespace` here is never `undefined` for that index.
 *
 * Consistency — IMPORTANT: Vectorize is external and non-transactional, so this
 * hook runs AFTER the mutation's transaction has committed, never inside it (the
 * shard host holds it — `ShardDO.deferAfterCommit`). That ordering is what stops
 * a rolled-back write from leaving a vector for a row that does not exist, and a
 * rolled-back delete from leaving a live row with its vector already purged.
 *
 * Two commits to the same row do not race: the shard host drains one
 * transaction's held work entirely before the next transaction's, so the hooks
 * apply in COMMIT order even though each may take hundreds of milliseconds. Fan
 * out within a single hook is still unordered — the indexes are independent.
 *
 * What remains is the opposite divergence, and it is the one worth having: the
 * row is committed and this hook may still fail — fully, or partway through a
 * fan-out that already applied to some indexes. The row is then indexed in some
 * indexes and not others. Nothing is compensated, deliberately: the row SURVIVES
 * a failure here, so purging the indexes that did apply would turn a partially
 * indexed row into an unsearchable one. Upserts and deletes are idempotent
 * (keyed by row id), so re-running the same write converges.
 */
const createVectorSyncHook = (options: { allowSharedNamespace?: boolean; namespace?: string; schema: SchemaLike; vectors: VectorSearchLike }): WriteHook => {
    const { allowSharedNamespace, namespace, schema, vectors } = options;

    return async (event: WriteEvent): Promise<void> => {
        const plan = planRowSync(schema, event);

        if (!plan) {
            return;
        }

        // Each index is independent, so the calls fan out — bounded, since an
        // embedder is usually a remote call and a table may carry many indexes.
        // A partial failure is left partial (see the docblock).
        const operations: (() => Promise<void>)[] = [
            ...plan.deletes.map((name) => async (): Promise<void> => {
                await vectors.deleteByIds(name, [event.id]);
            }),
            ...plan.upserts.map((upsert) => async (): Promise<void> => {
                if (!allowSharedNamespace && namespace === undefined) {
                    warnSharedNamespace(upsert.name);
                }

                // `upsertNow`, not `upsert`: the shard host already holds this
                // whole hook until the commit lands, and deferring again from
                // inside the drain would be a second hop to nowhere.
                await vectors.upsertNow(upsert.name, { embed: upsert.embed, id: event.id, input: upsert.input, metadata: upsert.metadata, namespace });
            }),
        ];

        await concurrentMap(operations, UPSERT_EMBED_CONCURRENCY, async (operation) => operation());
    };
};

/** A row the backfill could not index, and why. */
interface VectorBackfillFailure {
    error: unknown;
    id: string;
}

/**
 * Index one page of rows for the shard's vector backfill. Resolves with the rows
 * that failed on their own; REJECTS when the failure is the service's rather than
 * a row's, so the caller holds its cursor and retries the page — with a
 * `SERVICE_UNAVAILABLE` `LunoraError` when the error shows the failure to be
 * transient, and with the raw error when only the whole page failing suggests it.
 */
type VectorBackfillSync = (table: string, rows: ReadonlyArray<{ doc: Record<string, unknown>; id: string }>) => Promise<ReadonlyArray<VectorBackfillFailure>>;

/** Vectorize's ceiling on one upsert or id-batch call. */
const MAX_BATCH = 1000;

const chunk = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
    const chunks: T[][] = [];

    for (let start = 0; start < items.length; start += size) {
        chunks.push(items.slice(start, start + size));
    }

    return chunks;
};

/**
 * What one failed call says, as far as the error itself tells.
 *
 * `row` — the request was refused as invalid: an HTTP 4xx other than 408/429, or
 * a `TypeError`/`RangeError` raised before anything was sent. It fails the same
 * way on every retry.
 *
 * `service` — the call itself failed: an HTTP 5xx, 408 or 429, or a
 * `TimeoutError`/`AbortError`. Retrying can succeed.
 *
 * `unknown` — anything else. The Workers AI and Vectorize bindings throw plain
 * `Error`s whose only detail is the message, so this is the common case for them.
 */
const classifyFailure = (error: unknown): "row" | "service" | "unknown" => {
    if (typeof error !== "object" || error === null) {
        return "unknown";
    }

    const { name, status, statusCode } = error as { name?: unknown; status?: unknown; statusCode?: unknown };
    const code = typeof status === "number" ? status : statusCode;

    if (typeof code === "number") {
        if (code >= 500 || code === 408 || code === 429) {
            return "service";
        }

        if (code >= 400) {
            return "row";
        }
    }

    if (name === "TimeoutError" || name === "AbortError") {
        return "service";
    }

    return error instanceof TypeError || error instanceof RangeError ? "row" : "unknown";
};

/**
 * Run `attempt` over each item and split the results into rows that went
 * through and rows that failed on their own. Rejects instead — so the caller
 * holds its cursor and retries the page — when the failure is the service's.
 *
 * That is any failure classified `service` ({@link classifyFailure}): that row
 * was never really tried, and recording it as failed would move past it.
 *
 * It is also two or more items tried and EVERY one failed, unless every failure
 * is classified `row`. With no status to go on, a whole group failing is far
 * more likely an outage than a set of bad rows. A group that fails this way
 * deterministically is written off by the backfill's strike count instead.
 */
const settleEach = async <T, U>(
    items: ReadonlyArray<T>,
    attempt: (item: T) => Promise<U>,
): Promise<{ failed: { error: unknown; item: T }[]; ok: { item: T; value: U }[] }> => {
    const settled = await concurrentMap(items, UPSERT_EMBED_CONCURRENCY, async (item) => {
        try {
            return { item, ok: true as const, value: await attempt(item) };
        } catch (error) {
            return { error, item, ok: false as const };
        }
    });
    const ok = settled.flatMap((entry) => (entry.ok ? [{ item: entry.item, value: entry.value }] : []));
    const failed = settled.flatMap((entry) => (entry.ok ? [] : [{ error: entry.error, item: entry.item }]));

    const service = failed.find(({ error }) => classifyFailure(error) === "service");

    if (service) {
        throw service.error;
    }

    if (items.length >= 2 && ok.length === 0 && failed.some(({ error }) => classifyFailure(error) !== "row")) {
        throw failed[0]?.error;
    }

    return { failed, ok };
};

/**
 * The backfill's counterpart to {@link createVectorSyncHook}: the same
 * {@link planRowSync} decision for a whole page of rows, with the remote calls
 * batched — every row is embedded (bounded concurrency), then each index takes
 * ONE `upsertMany` and ONE `deleteByIds` per 1000 rows instead of a call per row.
 * That is what keeps a page short enough to hold the shard's write-hook chain.
 *
 * Failures are split in two, because they need opposite handling.
 *
 * A ROW failure is deterministic and would fail on every retry: a non-string
 * source, a `select()` that throws, text the model rejects, metadata Vectorize
 * refuses. The row is reported and the page moves on — the live hook only logs
 * these too, and a backfill that stopped on one would never finish.
 *
 * A SERVICE failure is transient: the embedder or Vectorize is unreachable. The
 * call rejects, so the page is retried. It is recognised by the error where the
 * error says (an HTTP 5xx/408/429 status, a timeout — see {@link classifyFailure};
 * these reject as `SERVICE_UNAVAILABLE`), and otherwise as every attempt in a
 * group of two or more failing, and as a failed `deleteByIds` (which has no row
 * content to blame). A batch `upsertMany` that fails is retried one row at a
 * time to tell the two apart. A group that fails whole on every retry — each
 * row refused for the same reason, with no status to show it — rejects each
 * time too; the backfill writes such a page off after a few consecutive tries.
 *
 * `upsertMany` is the raw binding call, so the namespace is passed explicitly —
 * the same `namespace` the live hook scopes by.
 */
type BackfillSyncOptions = {
    allowSharedNamespace?: boolean;
    namespace?: string;
    schema: SchemaLike;
    upsertMany: LunoraVectors["upsertMany"];
    vectors: VectorSearchLike;
};

/** Plan every row of a page; a row whose plan throws is recorded in `failed` and contributes nothing. */
const planPage = (
    schema: SchemaLike,
    table: string,
    rows: ReadonlyArray<{ doc: Record<string, unknown>; id: string }>,
    failed: Map<string, unknown>,
): { deletes: Map<string, string[]>; pending: { id: string; upsert: PlannedUpsert }[] } => {
    const deletes = new Map<string, string[]>();
    const pending: { id: string; upsert: PlannedUpsert }[] = [];

    for (const { doc, id } of rows) {
        let plan: RowSyncPlan | undefined;

        try {
            plan = planRowSync(schema, { doc, id, op: "update", table });
        } catch (error) {
            failed.set(id, error);
            continue;
        }

        for (const name of plan?.deletes ?? []) {
            deletes.set(name, [...(deletes.get(name) ?? []), id]);
        }

        for (const upsert of plan?.upserts ?? []) {
            pending.push({ id, upsert });
        }
    }

    return { deletes, pending };
};

/**
 * Write one index's embedded rows: one `upsertMany` per {@link MAX_BATCH}, and
 * — when a batch is refused — one `upsertNow` per row of it, so the refused rows
 * can be told from the rest and recorded in `failed`.
 */
const writeIndex = async (
    options: BackfillSyncOptions,
    name: string,
    entries: ReadonlyArray<{ id: string; upsert: PlannedUpsert; values: ReadonlyArray<number> }>,
    failed: Map<string, unknown>,
): Promise<void> => {
    const { allowSharedNamespace, namespace, upsertMany, vectors } = options;

    if (!allowSharedNamespace && namespace === undefined) {
        warnSharedNamespace(name);
    }

    // The vector is already computed, so the "embedder" handed on just returns
    // it: the batch call does no embedding of its own.
    const inputs = entries.map(({ id, upsert, values }) => {
        return { embed: () => values, id, input: upsert.input, metadata: upsert.metadata, namespace };
    });

    for (const batch of chunk(inputs, MAX_BATCH)) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one batch call per index at a time keeps the subrequest count flat
            await upsertMany(name, batch);
        } catch {
            // eslint-disable-next-line no-await-in-loop -- the fallback for one refused batch
            const single = await settleEach(batch, async (input) => vectors.upsertNow(name, input));

            for (const { error, item } of single.failed) {
                failed.set(item.id, error);
            }
        }
    }
};

const syncPage = async (
    options: BackfillSyncOptions,
    table: string,
    rows: ReadonlyArray<{ doc: Record<string, unknown>; id: string }>,
): Promise<ReadonlyArray<VectorBackfillFailure>> => {
    const failed = new Map<string, unknown>();
    const { deletes, pending } = planPage(options.schema, table, rows, failed);
    const embedded = await settleEach(pending, async ({ upsert }) => upsert.embed(upsert.input));
    const byIndex = new Map<string, { id: string; upsert: PlannedUpsert; values: ReadonlyArray<number> }[]>();

    for (const { error, item } of embedded.failed) {
        failed.set(item.id, error);
    }

    for (const { item, value } of embedded.ok) {
        byIndex.set(item.upsert.name, [...(byIndex.get(item.upsert.name) ?? []), { ...item, values: value }]);
    }

    for (const [name, ids] of deletes) {
        for (const batch of chunk(ids, MAX_BATCH)) {
            // eslint-disable-next-line no-await-in-loop -- one batch call per index at a time keeps the subrequest count flat
            await options.vectors.deleteByIds(name, batch);
        }
    }

    for (const [name, entries] of byIndex) {
        // eslint-disable-next-line no-await-in-loop -- indexes one at a time keeps the subrequest count flat
        await writeIndex(options, name, entries, failed);
    }

    return [...failed].map(([id, error]) => {
        return { error, id };
    });
};

const createVectorBackfillSync =
    (options: BackfillSyncOptions): VectorBackfillSync =>
    async (table, rows) => {
        try {
            return await syncPage(options, table, rows);
        } catch (error) {
            // A failure the error itself shows to be transient is re-thrown as
            // `SERVICE_UNAVAILABLE`, so the backfill holds its cursor on it without
            // counting it toward writing the page off.
            if (classifyFailure(error) === "service") {
                throw new LunoraError("SERVICE_UNAVAILABLE", error instanceof Error ? error.message : String(error), { cause: error });
            }

            throw error;
        }
    };

/**
 * Every table with a vector index sourced from it, each with a fingerprint of
 * what its stored vectors were built from — the input to the shard's vector
 * backfill, which re-walks a table whose fingerprint changed.
 *
 * Covers what the schema can see: index names, the inline source field,
 * dimensions, metric, inline metadata fields, the declared `model`, and the
 * table's `.softDelete()` field — a row hidden by a newly chosen marker keeps
 * its vector until the table is walked again. A
 * function (`embed`, a Shape B `select`/`metadata`) has no stable identity to
 * fingerprint — its source text changes with unrelated rebuilds of the bundle,
 * which would re-embed whole tables for nothing — so the declared `model` string
 * stands in for `embed`, and any other change is announced by calling the
 * backfill with `restart: true`.
 *
 * `model` joins a descriptor only when declared, and the soft-delete field only
 * when the table has one, so an index without either keeps the fingerprint it
 * was recorded under and is not re-embedded for it.
 */
const vectorBackfillTargets = (schema: SchemaLike): { profile: string; table: string }[] => {
    const byTable = new Map<string, string[]>();
    const add = (table: string, descriptor: unknown[], model: string | undefined): void => {
        const described = model === undefined ? descriptor : [...descriptor, model];

        byTable.set(table, [...(byTable.get(table) ?? []), JSON.stringify(described)]);
    };

    for (const [table, definition] of Object.entries(schema.tables)) {
        for (const index of definition.vectorIndexes ?? []) {
            add(table, [index.name, index.field, index.dimensions, index.metric, index.metadata ?? []], index.model);
        }
    }

    for (const [name, index] of Object.entries(schema.vectorIndexes)) {
        add(index.table, [name, "(select)", index.dimensions, index.metric], index.model);
    }

    return [...byTable].map(([table, descriptors]) => {
        const softDeleteField = schema.tables[table]?.softDeleteMode?.field;
        const described = softDeleteField === undefined ? descriptors : [...descriptors, JSON.stringify(["(softDelete)", softDeleteField])];

        return { profile: described.toSorted((a, b) => a.localeCompare(b)).join("|"), table };
    });
};

export type {
    CreateContextVectorsOptions,
    SchemaLike,
    TableDefinitionLike,
    TableVectorIndexLike,
    VectorBackfillFailure,
    VectorBackfillSync,
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
export { createContextVectors, createVectorBackfillSync, createVectorSyncHook, vectorBackfillTargets };
