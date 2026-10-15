/**
 * A vector store over any SQL engine reachable through a {@link RagSqlExec} —
 * a Durable Object's SQLite, D1, or `node:sqlite`.
 *
 * **This is the adapter that makes a RAG index not require Vectorize.** It also
 * removes the account-global-namespace hazard entirely rather than warning
 * about it: when the executor is a shard's own SQLite, the shard *is* the
 * tenant boundary, so one tenant's vectors are not merely filtered away from
 * another's — they are in a different database.
 *
 * **Nearest-neighbour search is brute force by default.** Every vector in the
 * namespace is read and scored in JS, because SQLite has no vector type and
 * `sqlite-vec` is not loadable inside workerd. That is a real bound, not a
 * detail: it is linear in namespace size, so this suits **many small
 * per-tenant indexes** — the shape most sharded apps actually have — and not
 * one large shared corpus. For that, use Vectorize or a pgvector backend.
 *
 * Where the SQLite does have `sqlite-vec` — a celld Durable Object with the
 * `sqlite_vec` compatibility flag, or `node:sqlite` with the extension loaded
 * — {@link SqliteVectorStoreOptions.ann} adds a `vec0` index beside the table
 * and an unfiltered query becomes a KNN lookup instead of a scan.
 * @experimental
 */
import matchesMetadataFilter from "./metadata-filter";
import type { RagSqlExec } from "./sql";
import { assertSafeIdentifier, cosineSimilarity, inListBatches, placeholderList, readJsonColumn } from "./sql";
import type { SqliteVecIndex } from "./sqlite-vec-index";
import { sqliteVecIndex } from "./sqlite-vec-index";
import type { RagVectorMatch, RagVectorMatches, RagVectorQueryInput, RagVectorRecord, RagVectorUpsertInput } from "./types";
import type { RagVectorStore, RagVectorStoreCapabilities } from "./vector-store";

/** Options for {@link sqliteVectorStore}. */
interface SqliteVectorStoreOptions {
    /**
     * Keep a `sqlite-vec` `vec0` index (cosine distance) in `<table>_ann`, one
     * partition per namespace. Requires the extension in the executor's SQLite;
     * without it the first operation throws naming the missing module.
     *
     * The JSON table stays the source of truth: an index created over an
     * existing table is backfilled from it, and a match the table no longer
     * holds is dropped. Only an **unfiltered** query uses the index — `vec0`
     * applies a metadata filter after picking the `k` nearest, which would
     * return a short page, so a filtered query keeps the exact scan (and its
     * `maxScan` bound).
     */
    ann?: { dimensions: number };

    /** Execute one statement. See {@link RagSqlExec}. */
    exec: RagSqlExec;

    /**
     * Ceiling on embedding dimensionality. Defaults to `false` (no limit) —
     * vectors are stored as JSON, so nothing here cares how wide they are, and
     * inheriting Vectorize's 1536 would be inventing a constraint.
     */
    maxDimensions?: number | false;

    /**
     * Upper bound on how many rows a single namespace may be scanned for.
     * Default 50,000.
     *
     * Search is linear, so this is the difference between a slow query and a
     * Worker that exceeds its CPU budget and is killed with nothing explaining
     * why. Exceeding it throws, naming the namespace and the count.
     */
    maxScan?: number;

    /** Table name. Default `lunora_rag_vectors`. Must be a bare SQL identifier. */
    table?: string;
}

const DEFAULT_TABLE = "lunora_rag_vectors";
const DEFAULT_MAX_SCAN = 50_000;

/**
 * Result-count ceiling reported through {@link RagVectorStoreCapabilities}.
 *
 * Deliberately NOT {@link SqliteVectorStoreOptions.maxScan}: that bounds how
 * much of a namespace may be READ, which is a corpus-size limit and says
 * nothing about how many chunks a single retrieval should return. Publishing it
 * as `maxTopK` let `retrieve(q, { topK: 50000 })` through, and every one of
 * those chunks is concatenated into one prompt. 100 matches the ceiling the
 * text-store path advertises everywhere else.
 */
const MAX_TOP_K = 100;

/**
 * The value bound for a SQL NULL. `null` is not interchangeable with
 * `undefined` here — drivers bind `undefined` as "no parameter" or reject it
 * outright, so this is the one place the codebase's no-`null` rule does not
 * apply.
 */
// eslint-disable-next-line unicorn/no-null -- a SQL NULL binding; `undefined` is not accepted by the drivers
const SQL_NULL = null;

/** `undefined` and `""` are the same namespace — the un-namespaced one. */
const namespaceKey = (namespace: string | undefined): string => namespace ?? "";

const sqliteVectorStore = (options: SqliteVectorStoreOptions): RagVectorStore => {
    if (typeof options.exec !== "function") {
        throw new TypeError("@lunora/ai/rag: sqliteVectorStore requires an `exec` function");
    }

    const table = assertSafeIdentifier(options.table ?? DEFAULT_TABLE, "sqliteVectorStore `table`");
    const maxScan = options.maxScan ?? DEFAULT_MAX_SCAN;
    const { ann, exec } = options;

    if (ann !== undefined && (!Number.isInteger(ann.dimensions) || ann.dimensions <= 0)) {
        throw new TypeError("@lunora/ai/rag: sqliteVectorStore `ann.dimensions` must be a positive integer");
    }

    const annIndex = ann === undefined ? undefined : sqliteVecIndex({ dimensions: ann.dimensions, exec, table });

    const capabilities: RagVectorStoreCapabilities = {
        // A vec0 column has one fixed width; a wider embedding cannot be indexed.
        maxDimensions: options.maxDimensions ?? ann?.dimensions ?? false,
        // Rows are TEXT columns in an ordinary table: neither the id nor the
        // metadata has a budget to enforce.
        maxIdBytes: false,
        maxMetadataBytes: false,
        // Metadata is an ordinary TEXT column, so returning it costs nothing
        // extra and the two ceilings are the same number.
        maxTopK: MAX_TOP_K,
        maxTopKWithMetadata: MAX_TOP_K,
    };

    /**
     * Create the table on first use. Idempotent, and awaited by every operation
     * so a store handed a fresh database works without a migration step.
     *
     * A failed attempt clears the memo rather than caching the rejection: the
     * promise is stored before it settles, so without this one transient error
     * poisons the store for the isolate's lifetime and every later operation
     * re-throws it.
     */
    let ready: Promise<void> | undefined;

    const ensureTable = async (): Promise<void> => {
        ready ??= (async (): Promise<void> => {
            await exec(
                `CREATE TABLE IF NOT EXISTS ${table} (id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '', vector TEXT NOT NULL, metadata TEXT, PRIMARY KEY (namespace, id))`,
                [],
            );
            await exec(`CREATE INDEX IF NOT EXISTS ${table}_namespace ON ${table} (namespace)`, []);

            await annIndex?.ensure();
        })().catch((error: unknown) => {
            ready = undefined;

            throw error;
        });

        await ready;
    };

    const upsert = async (input: RagVectorUpsertInput): Promise<unknown> => {
        await ensureTable();

        if (!input.embed) {
            throw new TypeError("@lunora/ai/rag: sqliteVectorStore requires an `embed` function on upsert");
        }

        const vector = await input.embed(input.input);
        const namespace = namespaceKey(input.namespace);

        // Before the table write — see `sqlite-vec-index.ts` for the order.
        await annIndex?.put(namespace, input.id, vector);

        // ON CONFLICT rather than DELETE+INSERT: re-indexing a source rewrites
        // the same ids, and the two-statement form would leave a window where a
        // concurrent read sees the chunk missing.
        //
        // The conflict target is (namespace, id), matching the primary key —
        // on `id` alone, re-indexing a chunk id that another tenant also uses
        // would rewrite THEIR row into this namespace, losing their data.
        await exec(
            `INSERT INTO ${table} (id, namespace, vector, metadata) VALUES (${placeholderList(4)}) ` +
                `ON CONFLICT(namespace, id) DO UPDATE SET vector = excluded.vector, metadata = excluded.metadata`,
            [input.id, namespace, JSON.stringify([...vector]), input.metadata === undefined ? SQL_NULL : JSON.stringify(input.metadata)],
        );

        return undefined;
    };

    const getByIds = async (ids: ReadonlyArray<string>, namespace?: string): Promise<ReadonlyArray<RagVectorRecord>> => {
        await ensureTable();

        if (ids.length === 0) {
            return [];
        }

        const records: RagVectorRecord[] = [];

        // One statement per batch: a caller-sized `IN (…)` list is a caller-
        // sized placeholder count, and workerd's per-statement cap is 100.
        for (const batch of inListBatches(ids)) {
            // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; concurrent fan-out would multiply the subrequest budget
            const rows = await exec(`SELECT id, metadata FROM ${table} WHERE namespace = ? AND id IN (${placeholderList(batch.length)})`, [
                namespaceKey(namespace),
                ...batch,
            ]);

            for (const row of rows) {
                const metadata = readJsonColumn(row["metadata"]) as Record<string, unknown> | undefined;

                records.push({ id: String(row["id"]), ...(metadata === undefined ? {} : { metadata }) });
            }
        }

        return records;
    };

    /**
     * KNN through the `vec0` index, then the table for metadata. Ranked by the
     * index; a match whose row is gone (an interrupted upsert or delete) is
     * dropped rather than returned without its record.
     */
    const queryIndex = async (index: SqliteVecIndex, values: ReadonlyArray<number>, input: RagVectorQueryInput): Promise<RagVectorMatches> => {
        const namespace = namespaceKey(input.namespace);
        const nearest = await index.nearest(namespace, values, input.topK ?? 10);
        const stored = await getByIds(
            nearest.map((match) => match.id),
            namespace,
        );
        const records = new Map(stored.map((record) => [record.id, record]));
        const matches: RagVectorMatch[] = [];

        for (const { distance, id } of nearest) {
            const record = records.get(id);

            if (record === undefined) {
                continue;
            }

            matches.push({
                id,
                // vec0's cosine distance is `1 - similarity`, so this is the
                // same score the scan path computes.
                score: 1 - distance,
                ...(input.returnMetadata === "none" || record.metadata === undefined ? {} : { metadata: record.metadata }),
            });
        }

        return { count: matches.length, matches };
    };

    const query = async (input: RagVectorQueryInput): Promise<RagVectorMatches> => {
        await ensureTable();

        let values: ReadonlyArray<number>;

        if (input.embed && input.input !== undefined) {
            values = await input.embed(input.input);
        } else {
            throw new TypeError("@lunora/ai/rag: sqliteVectorStore query requires both `input` and `embed`");
        }

        if (annIndex !== undefined && input.filter === undefined) {
            return queryIndex(annIndex, values, input);
        }

        // `LIMIT maxScan + 1` rather than an unbounded SELECT: the overflow row
        // is what proves the namespace outgrew the bound, and reading only one
        // past it is the difference between an explanatory error and an isolate
        // OOM-killed materialising 50 000 JSON vectors before it can throw.
        const rows = await exec(`SELECT id, vector, metadata FROM ${table} WHERE namespace = ? LIMIT ?`, [namespaceKey(input.namespace), maxScan + 1]);

        if (rows.length > maxScan) {
            throw new RangeError(
                `@lunora/ai/rag: sqliteVectorStore scanned ${String(rows.length)} vectors in namespace "${namespaceKey(input.namespace)}", over the ${String(maxScan)} limit — ` +
                    "search here is brute force and linear, so this namespace has outgrown it. Shard it further, or move this index to Vectorize or a pgvector backend",
            );
        }

        const matches: RagVectorMatch[] = [];

        for (const row of rows) {
            const metadata = readJsonColumn(row["metadata"]) as Record<string, unknown> | undefined;

            // The filter is applied BEFORE ranking, so an excluded row cannot
            // occupy a topK slot a permitted one should have had.
            if (!matchesMetadataFilter(metadata, input.filter)) {
                continue;
            }

            const stored = readJsonColumn(row["vector"]) as number[] | undefined;

            if (stored === undefined) {
                continue;
            }

            matches.push({
                id: String(row["id"]),
                score: cosineSimilarity(values, stored),
                ...(input.returnMetadata === "none" || metadata === undefined ? {} : { metadata }),
            });
        }

        const ranked = matches.toSorted((a, b) => b.score - a.score).slice(0, input.topK ?? 10);

        return { count: ranked.length, matches: ranked };
    };

    const deleteByIds = async (ids: ReadonlyArray<string>, namespace?: string): Promise<unknown> => {
        await ensureTable();

        if (ids.length === 0) {
            return undefined;
        }

        // Scoped by namespace as well as id: the caller's namespace is the
        // tenant boundary, and a delete that ignored it would let one tenant
        // remove another's chunk by guessing an id.
        for (const batch of inListBatches(ids)) {
            // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; see `getByIds`
            await exec(`DELETE FROM ${table} WHERE namespace = ? AND id IN (${placeholderList(batch.length)})`, [namespaceKey(namespace), ...batch]);
            // After the table delete — see `sqlite-vec-index.ts` for the order.
            // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; see `getByIds`
            await annIndex?.remove(namespaceKey(namespace), batch);
        }

        return undefined;
    };

    return { capabilities, deleteByIds, getByIds, query, upsert };
};

export type { SqliteVectorStoreOptions };
export { sqliteVectorStore };
