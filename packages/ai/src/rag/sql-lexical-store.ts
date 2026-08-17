/**
 * A **durable** BM25 lexical store over any SQL engine reachable through a
 * {@link RagSqlExec} — a Durable Object's SQLite, D1, or `node:sqlite`.
 *
 * `bm25LexicalStore` keeps its inverted index in the isolate, so it is not
 * durable and not shared across isolates: restart the isolate and the keyword
 * leg of hybrid retrieval silently returns nothing until every source is
 * re-indexed. This one persists the index, so hybrid search survives a deploy.
 *
 * It scores through the same {@link bm25TermScore} kernel as the in-memory
 * store, so swapping one for the other does not move the ranking.
 * @experimental
 */
import { bm25Idf, bm25TermScore, tokenize, tokenizeQuery } from "./bm25";
import matchesMetadataFilter from "./metadata-filter";
import type { RagSqlExec } from "./sql";
import { assertSafeIdentifier, IN_LIST_BUDGET, inListBatches, placeholderList, readJsonColumn } from "./sql";
import type { LexicalMatch, RagLexicalStore } from "./types";

/** Options for {@link sqlLexicalStore}. */
interface SqlLexicalStoreOptions {
    /** Execute one statement. See {@link RagSqlExec}. */
    exec: RagSqlExec;

    /**
     * Table-name prefix. Default `lunora_rag_lexical`; the postings table is
     * this plus `_terms`. Must be a bare SQL identifier.
     */
    table?: string;
}

const DEFAULT_TABLE = "lunora_rag_lexical";

/** The value bound for a SQL NULL — see the note in `sqlite-vector-store.ts`. */
// eslint-disable-next-line unicorn/no-null -- a SQL NULL binding; `undefined` is not accepted by the drivers
const SQL_NULL = null;

/** `undefined` and `""` are the same namespace — the un-namespaced one. */
const namespaceKey = (namespace: string | undefined): string => namespace ?? "";

/** Read an integer column defensively — drivers disagree on whether counts come back as numbers or strings. */
const readCount = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
};

const sqlLexicalStore = (options: SqlLexicalStoreOptions): RagLexicalStore => {
    if (typeof options.exec !== "function") {
        throw new TypeError("@lunora/ai/rag: sqlLexicalStore requires an `exec` function");
    }

    // Keyed by (namespace, id), not id alone: chunk ids are unique only WITHIN
    // a namespace, so a bare `id` primary key lets one tenant's chunk collide
    // with — and overwrite — another's.
    const documents = assertSafeIdentifier(options.table ?? DEFAULT_TABLE, "sqlLexicalStore `table`");
    const terms = `${documents}_terms`;
    const { exec } = options;

    let ready: Promise<void> | undefined;

    const ensureTables = async (): Promise<void> => {
        ready ??= (async (): Promise<void> => {
            await exec(
                `CREATE TABLE IF NOT EXISTS ${documents} (id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, length INTEGER NOT NULL, metadata TEXT, PRIMARY KEY (namespace, id))`,
                [],
            );
            await exec(
                `CREATE TABLE IF NOT EXISTS ${terms} (term TEXT NOT NULL, id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '', frequency INTEGER NOT NULL, PRIMARY KEY (namespace, term, id))`,
                [],
            );
            // The read path looks up postings by (namespace, term); without this
            // every search degrades to a full scan of the postings table, which
            // is the one thing a durable inverted index exists to avoid.
            await exec(`CREATE INDEX IF NOT EXISTS ${terms}_lookup ON ${terms} (namespace, term)`, []);
            await exec(`CREATE INDEX IF NOT EXISTS ${documents}_namespace ON ${documents} (namespace)`, []);
        })().catch((error: unknown) => {
            // Clear the memo on failure. The promise is stored before it
            // settles, so caching a rejection would poison the store for the
            // isolate's lifetime over one transient error.
            ready = undefined;

            throw error;
        });

        await ready;
    };

    const removeIds = async (ids: ReadonlyArray<string>, namespace: string): Promise<void> => {
        // Batched because the placeholder count of an `IN (…)` list is
        // caller-sized: re-indexing a 125-chunk document would otherwise bind
        // 126 parameters, over workerd's per-statement cap of 100.
        for (const batch of inListBatches(ids)) {
            const list = placeholderList(batch.length);

            // Postings first: a crash between the two leaves orphaned postings,
            // which score nothing because the join to `documents` drops them. The
            // reverse order would leave documents with no postings — findable by
            // nothing, but still counted in the corpus statistics.
            // eslint-disable-next-line no-await-in-loop -- one bounded statement pair per batch, ordered on purpose
            await exec(`DELETE FROM ${terms} WHERE namespace = ? AND id IN (${list})`, [namespace, ...batch]);
            // eslint-disable-next-line no-await-in-loop -- see above
            await exec(`DELETE FROM ${documents} WHERE namespace = ? AND id IN (${list})`, [namespace, ...batch]);
        }
    };

    /**
     * Insert `rows` through as few statements as the placeholder cap allows.
     *
     * One statement per row is what this replaces: a 100-chunk document with
     * ~150 distinct terms per chunk is ~15 000 sequential `exec` calls, and on
     * D1 each of those is a round trip against a Worker's subrequest budget.
     * Multi-row `VALUES` collapses them, batched so a statement never binds
     * more than {@link IN_LIST_BUDGET} parameters.
     */
    const insertRows = async (into: string, columns: number, rows: ReadonlyArray<ReadonlyArray<unknown>>): Promise<void> => {
        const tuple = `(${placeholderList(columns)})`;

        for (const batch of inListBatches(rows, IN_LIST_BUDGET / columns)) {
            // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; concurrent fan-out would multiply the subrequest budget
            await exec(
                `${into} VALUES ${Array.from({ length: batch.length }).fill(tuple).join(", ")}`,
                batch.flatMap((row) => [...row]),
            );
        }
    };

    return {
        index: async (chunks, indexOptions) => {
            await ensureTables();

            const namespace = namespaceKey(indexOptions.namespace);

            // Idempotent re-index: drop each chunk's prior revision first, so a
            // shrinking document cannot leave stale postings behind.
            await removeIds(
                chunks.map((chunk) => chunk.id),
                namespace,
            );

            const documentRows: unknown[][] = [];
            const termRows: unknown[][] = [];

            for (const chunk of chunks) {
                const tokens = tokenize(chunk.text);

                // A token-less chunk can never match; leaving it out keeps it
                // from inflating the corpus statistics with a zero-length row.
                if (tokens.length === 0) {
                    continue;
                }

                const frequencies = new Map<string, number>();

                for (const token of tokens) {
                    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
                }

                documentRows.push([chunk.id, namespace, chunk.text, tokens.length, chunk.metadata === undefined ? SQL_NULL : JSON.stringify(chunk.metadata)]);

                for (const [term, frequency] of frequencies) {
                    termRows.push([term, chunk.id, namespace, frequency]);
                }
            }

            // Postings before documents, the inverse of `removeIds` and for the
            // same reason: a crash between the two leaves orphaned postings,
            // which the join to `documents` drops. The reverse order would leave
            // documents nothing can find but the corpus statistics still count.
            await insertRows(`INSERT INTO ${terms} (term, id, namespace, frequency)`, 4, termRows);
            await insertRows(`INSERT INTO ${documents} (id, namespace, text, length, metadata)`, 5, documentRows);
        },
        remove: async (ids, removeOptions) => {
            await ensureTables();
            await removeIds(ids, namespaceKey(removeOptions.namespace));
        },
        search: async (query, searchOptions) => {
            await ensureTables();

            const namespace = namespaceKey(searchOptions.namespace);
            const queryTerms = tokenizeQuery(query);

            if (queryTerms.length === 0) {
                return [];
            }

            // Corpus statistics for this namespace. BM25's length normalisation
            // is relative to the average, so both are needed before any term
            // can be scored.
            const [stats] = await exec(`SELECT COUNT(*) AS document_count, COALESCE(SUM(length), 0) AS total_length FROM ${documents} WHERE namespace = ?`, [
                namespace,
            ]);
            const documentCount = readCount(stats?.["document_count"]);

            if (documentCount === 0) {
                return [];
            }

            const averageLength = readCount(stats?.["total_length"]) / documentCount;

            // One join fetches the postings for every query term together with
            // what each needs for scoring and filtering — rather than a query
            // per term plus a hydration round-trip per hit. Split across
            // statements only when the query has more distinct terms than one
            // statement may bind placeholders for.
            //
            // `d.text` is deliberately NOT selected here. A posting row exists
            // per (term, document), so a term common to the corpus returns one
            // row per matching document — and carrying the document body on
            // every one of them reads the whole corpus into the isolate to rank
            // it and then discards all but `topK`. Only `length` (for BM25's
            // length normalisation) and `metadata` (for the filter) are needed
            // to score; the bodies are fetched below, for the survivors only.
            const rows: Record<string, unknown>[] = [];

            for (const batch of inListBatches(queryTerms)) {
                // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; a query rarely has more than 64 distinct terms
                const batchRows = await exec(
                    `SELECT t.term AS term, t.id AS id, t.frequency AS frequency, d.length AS length, d.metadata AS metadata ` +
                        `FROM ${terms} t JOIN ${documents} d ON d.id = t.id AND d.namespace = t.namespace ` +
                        `WHERE t.namespace = ? AND t.term IN (${placeholderList(batch.length)})`,
                    [namespace, ...batch],
                );

                rows.push(...batchRows);
            }

            // Document frequency per term, needed for IDF before any score is
            // accumulated — hence the two passes over `rows`.
            const documentFrequency = new Map<string, number>();

            for (const row of rows) {
                const term = String(row["term"]);

                documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
            }

            const scores = new Map<string, number>();

            for (const row of rows) {
                const metadata = readJsonColumn(row["metadata"]) as Record<string, unknown> | undefined;

                // Honour the same predicate the vector leg gets — the filter
                // carries the tenant/RBAC scope, so a hit it excludes must never
                // reach fusion.
                if (!matchesMetadataFilter(metadata, searchOptions.filter)) {
                    continue;
                }

                const id = String(row["id"]);
                const idf = bm25Idf(documentCount, documentFrequency.get(String(row["term"])) ?? 1);
                const contribution = bm25TermScore(idf, readCount(row["frequency"]), readCount(row["length"]), averageLength);

                scores.set(id, (scores.get(id) ?? 0) + contribution);
            }

            const ranked = [...scores.entries()].toSorted(([, a], [, b]) => b - a).slice(0, searchOptions.topK);

            if (ranked.length === 0) {
                return [];
            }

            // Hydrate the bodies now that the result set is bounded by `topK`,
            // so the text this reads is what the caller actually receives.
            const texts = new Map<string, string>();

            for (const batch of inListBatches(ranked.map(([id]) => id))) {
                // eslint-disable-next-line no-await-in-loop -- one bounded statement per batch; `topK` is small, so this is normally a single round trip
                const textRows = await exec(`SELECT id, text FROM ${documents} WHERE namespace = ? AND id IN (${placeholderList(batch.length)})`, [
                    namespace,
                    ...batch,
                ]);

                for (const row of textRows) {
                    texts.set(String(row["id"]), String(row["text"]));
                }
            }

            // `?? ""` covers a document deleted between the two statements: it
            // scored, so it is a real hit, and dropping it would silently
            // shorten the result set.
            const matches: LexicalMatch[] = ranked.map(([id, score]) => {
                return { id, score, text: texts.get(id) ?? "" };
            });

            return matches;
        },
    };
};

export type { SqlLexicalStoreOptions };
export { sqlLexicalStore };
