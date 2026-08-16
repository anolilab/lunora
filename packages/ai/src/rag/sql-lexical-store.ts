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
import { bm25Idf, bm25TermScore, tokenize } from "./bm25";
import matchesMetadataFilter from "./metadata-filter";
import type { RagSqlExec } from "./sql";
import { assertSafeIdentifier, placeholder, placeholderList, readJsonColumn } from "./sql";
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
        })();

        await ready;
    };

    const removeIds = async (ids: ReadonlyArray<string>, namespace: string): Promise<void> => {
        if (ids.length === 0) {
            return;
        }

        const list = placeholderList("sqlite", ids.length, 1);

        // Postings first: a crash between the two leaves orphaned postings,
        // which score nothing because the join to `documents` drops them. The
        // reverse order would leave documents with no postings — findable by
        // nothing, but still counted in the corpus statistics.
        await exec(`DELETE FROM ${terms} WHERE namespace = ${placeholder("sqlite", 0)} AND id IN (${list})`, [namespace, ...ids]);
        await exec(`DELETE FROM ${documents} WHERE namespace = ${placeholder("sqlite", 0)} AND id IN (${list})`, [namespace, ...ids]);
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

                // eslint-disable-next-line no-await-in-loop -- sequential per chunk: batching would need a driver-specific multi-row form
                await exec(`INSERT INTO ${documents} (id, namespace, text, length, metadata) VALUES (${placeholderList("sqlite", 5)})`, [
                    chunk.id,
                    namespace,
                    chunk.text,
                    tokens.length,
                    chunk.metadata === undefined ? SQL_NULL : JSON.stringify(chunk.metadata),
                ]);

                for (const [term, frequency] of frequencies) {
                    // eslint-disable-next-line no-await-in-loop -- one statement per distinct term; see above
                    await exec(`INSERT INTO ${terms} (term, id, namespace, frequency) VALUES (${placeholderList("sqlite", 4)})`, [
                        term,
                        chunk.id,
                        namespace,
                        frequency,
                    ]);
                }
            }
        },
        remove: async (ids, removeOptions) => {
            await ensureTables();
            await removeIds(ids, namespaceKey(removeOptions.namespace));
        },
        search: async (query, searchOptions) => {
            await ensureTables();

            const namespace = namespaceKey(searchOptions.namespace);
            const queryTerms = [...new Set(tokenize(query))];

            if (queryTerms.length === 0) {
                return [];
            }

            // Corpus statistics for this namespace. BM25's length normalisation
            // is relative to the average, so both are needed before any term
            // can be scored.
            const [stats] = await exec(
                `SELECT COUNT(*) AS document_count, COALESCE(SUM(length), 0) AS total_length FROM ${documents} WHERE namespace = ${placeholder("sqlite", 0)}`,
                [namespace],
            );
            const documentCount = readCount(stats?.["document_count"]);

            if (documentCount === 0) {
                return [];
            }

            const averageLength = readCount(stats?.["total_length"]) / documentCount;

            // One join fetches the postings for every query term together with
            // the document row each needs for scoring and filtering — rather
            // than a query per term plus a hydration round-trip per hit.
            const rows = await exec(
                `SELECT t.term AS term, t.id AS id, t.frequency AS frequency, d.length AS length, d.text AS text, d.metadata AS metadata ` +
                    `FROM ${terms} t JOIN ${documents} d ON d.id = t.id AND d.namespace = t.namespace ` +
                    `WHERE t.namespace = ${placeholder("sqlite", 0)} AND t.term IN (${placeholderList("sqlite", queryTerms.length, 1)})`,
                [namespace, ...queryTerms],
            );

            // Document frequency per term, needed for IDF before any score is
            // accumulated — hence the two passes over `rows`.
            const documentFrequency = new Map<string, number>();

            for (const row of rows) {
                const term = String(row["term"]);

                documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
            }

            const scores = new Map<string, { score: number; text: string }>();

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
                const existing = scores.get(id);

                if (existing) {
                    existing.score += contribution;
                } else {
                    scores.set(id, { score: contribution, text: String(row["text"]) });
                }
            }

            const matches: LexicalMatch[] = [...scores.entries()].map(([id, entry]) => {
                return { id, score: entry.score, text: entry.text };
            });

            return matches.toSorted((a, b) => b.score - a.score).slice(0, searchOptions.topK);
        },
    };
};

export type { SqlLexicalStoreOptions };
export default sqlLexicalStore;
