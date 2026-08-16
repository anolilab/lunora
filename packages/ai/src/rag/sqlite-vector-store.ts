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
 * **Nearest-neighbour search is brute force.** Every vector in the namespace is
 * read and scored in JS. There is no ANN index, because SQLite has no vector
 * type and `sqlite-vec` is not loadable inside workerd. That is a real bound,
 * not a detail: it is linear in namespace size, so this suits **many small
 * per-tenant indexes** — the shape most sharded apps actually have — and not
 * one large shared corpus. For that, use Vectorize or a pgvector backend.
 * @experimental
 */
import matchesMetadataFilter from "./metadata-filter";
import type { RagSqlExec } from "./sql";
import { assertSafeIdentifier, cosineSimilarity, placeholder, placeholderList, readJsonColumn } from "./sql";
import type { RagVectorMatch, RagVectorMatches, RagVectorQueryInput, RagVectorRecord, RagVectorUpsertInput } from "./types";
import type { RagVectorStore, RagVectorStoreCapabilities } from "./vector-store";

/** Options for {@link sqliteVectorStore}. */
interface SqliteVectorStoreOptions {
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
    const { exec } = options;

    const capabilities: RagVectorStoreCapabilities = {
        maxDimensions: options.maxDimensions ?? false,
        // Rows are TEXT columns in an ordinary table: no per-vector metadata
        // budget exists to enforce.
        maxMetadataBytes: false,
        maxTopK: maxScan,
        maxTopKWithMetadata: maxScan,
    };

    /**
     * Create the table on first use. Idempotent, and awaited by every operation
     * so a store handed a fresh database works without a migration step.
     */
    let ready: Promise<void> | undefined;

    const ensureTable = async (): Promise<void> => {
        ready ??= (async (): Promise<void> => {
            await exec(
                `CREATE TABLE IF NOT EXISTS ${table} (id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '', vector TEXT NOT NULL, metadata TEXT, PRIMARY KEY (namespace, id))`,
                [],
            );
            await exec(`CREATE INDEX IF NOT EXISTS ${table}_namespace ON ${table} (namespace)`, []);
        })();

        await ready;
    };

    const upsert = async (input: RagVectorUpsertInput): Promise<unknown> => {
        await ensureTable();

        if (!input.embed) {
            throw new TypeError("@lunora/ai/rag: sqliteVectorStore requires an `embed` function on upsert");
        }

        const vector = await input.embed(input.input);

        // ON CONFLICT rather than DELETE+INSERT: re-indexing a source rewrites
        // the same ids, and the two-statement form would leave a window where a
        // concurrent read sees the chunk missing.
        //
        // The conflict target is (namespace, id), matching the primary key —
        // on `id` alone, re-indexing a chunk id that another tenant also uses
        // would rewrite THEIR row into this namespace, losing their data.
        await exec(
            `INSERT INTO ${table} (id, namespace, vector, metadata) VALUES (${placeholderList("sqlite", 4)}) ` +
                `ON CONFLICT(namespace, id) DO UPDATE SET vector = excluded.vector, metadata = excluded.metadata`,
            [input.id, namespaceKey(input.namespace), JSON.stringify([...vector]), input.metadata === undefined ? SQL_NULL : JSON.stringify(input.metadata)],
        );

        return undefined;
    };

    const query = async (input: RagVectorQueryInput): Promise<RagVectorMatches> => {
        await ensureTable();

        let values: ReadonlyArray<number>;

        if (input.embed && input.input !== undefined) {
            values = await input.embed(input.input);
        } else {
            throw new TypeError("@lunora/ai/rag: sqliteVectorStore query requires both `input` and `embed`");
        }

        const rows = await exec(`SELECT id, vector, metadata FROM ${table} WHERE namespace = ${placeholder("sqlite", 0)}`, [namespaceKey(input.namespace)]);

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

    const getByIds = async (ids: ReadonlyArray<string>, namespace?: string): Promise<ReadonlyArray<RagVectorRecord>> => {
        await ensureTable();

        if (ids.length === 0) {
            return [];
        }

        const rows = await exec(
            `SELECT id, metadata FROM ${table} WHERE namespace = ${placeholder("sqlite", 0)} AND id IN (${placeholderList("sqlite", ids.length, 1)})`,
            [namespaceKey(namespace), ...ids],
        );

        return rows.map((row) => {
            const metadata = readJsonColumn(row["metadata"]) as Record<string, unknown> | undefined;

            return { id: String(row["id"]), ...(metadata === undefined ? {} : { metadata }) };
        });
    };

    const deleteByIds = async (ids: ReadonlyArray<string>, namespace?: string): Promise<unknown> => {
        await ensureTable();

        if (ids.length === 0) {
            return undefined;
        }

        // Scoped by namespace as well as id: the caller's namespace is the
        // tenant boundary, and a delete that ignored it would let one tenant
        // remove another's chunk by guessing an id.
        await exec(`DELETE FROM ${table} WHERE namespace = ${placeholder("sqlite", 0)} AND id IN (${placeholderList("sqlite", ids.length, 1)})`, [
            namespaceKey(namespace),
            ...ids,
        ]);

        return undefined;
    };

    return { capabilities, deleteByIds, getByIds, query, upsert };
};

export type { SqliteVectorStoreOptions };
export default sqliteVectorStore;
