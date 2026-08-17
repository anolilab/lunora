import { bm25Idf, bm25TermScore, tokenize, tokenizeQuery } from "./bm25";
import matchesMetadataFilter from "./metadata-filter";
import type { LexicalMatch, RagLexicalStore } from "./types";

/** One indexed chunk in a namespace's BM25 state. */
interface Bm25Document {
    length: number;
    /** The chunk's source metadata, kept so a filtered search can evaluate the predicate. */
    metadata?: Record<string, unknown>;
    termFrequency: ReadonlyMap<string, number>;
    text: string;
}

/** BM25 state for one namespace: the documents plus a term → (docId → tf) inverted index. */
interface NamespaceState {
    documents: Map<string, Bm25Document>;
    /** term → (docId → term-frequency). `size` of the inner map is the term's document frequency. */
    postings: Map<string, Map<string, number>>;
    totalLength: number;
}

/**
 * An **in-memory** Okapi BM25 lexical store — the reference adapter behind
 * `RagConfig.lexicalStore`, giving hybrid retrieval its keyword leg with zero
 * infrastructure. State lives in the worker isolate: it is **not durable and not
 * shared across isolates**, so it is intended for tests, local development, and
 * single-isolate workloads. Production deployments plug a durable
 * {@link RagLexicalStore} (a DO-SQLite inverted index, D1, or an external search
 * service) behind the same seam.
 *
 * Tenant isolation is by `namespace` (each namespace keeps its own index), and
 * each chunk's source `metadata` is stored alongside it so `search` evaluates
 * the **same** metadata predicate the vector leg receives — including an
 * `rlsFilter` result. A hit the filter excludes never reaches fusion.
 *
 * That matters because the filter carries the tenant/RBAC scope: a lexical leg
 * that ignored it would leak excluded chunk text into the fused result no
 * matter what the vector leg returned. This store previously had no metadata to
 * check and so refused every filtered query, which made hybrid search and
 * metadata-based RLS mutually exclusive.
 * @experimental
 */
const bm25LexicalStore = (): RagLexicalStore => {
    const namespaces = new Map<string, NamespaceState>();

    const stateFor = (namespace: string | undefined = ""): NamespaceState => {
        let state = namespaces.get(namespace);

        if (!state) {
            state = { documents: new Map(), postings: new Map(), totalLength: 0 };
            namespaces.set(namespace, state);
        }

        return state;
    };

    const removeDocument = (namespace: string | undefined, id: string): void => {
        const state = stateFor(namespace);
        const existing = state.documents.get(id);

        if (!existing) {
            return;
        }

        for (const term of existing.termFrequency.keys()) {
            const posting = state.postings.get(term);

            if (posting) {
                posting.delete(id);

                if (posting.size === 0) {
                    state.postings.delete(term);
                }
            }
        }

        state.totalLength -= existing.length;
        state.documents.delete(id);
    };

    const store: RagLexicalStore = {
        index: (chunks, options) => {
            const state = stateFor(options.namespace);

            for (const chunk of chunks) {
                // Idempotent re-index: drop the prior revision before re-adding.
                removeDocument(options.namespace, chunk.id);

                const tokens = tokenize(chunk.text);

                // A token-less chunk can never match — leave it unindexed (it was
                // already cleared above, so no stale revision lingers).
                if (tokens.length === 0) {
                    continue;
                }

                const termFrequency = new Map<string, number>();

                for (const token of tokens) {
                    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
                }

                for (const [term, frequency] of termFrequency) {
                    let posting = state.postings.get(term);

                    if (!posting) {
                        posting = new Map();
                        state.postings.set(term, posting);
                    }

                    posting.set(chunk.id, frequency);
                }

                state.documents.set(chunk.id, {
                    length: tokens.length,
                    termFrequency,
                    text: chunk.text,
                    ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata }),
                });
                state.totalLength += tokens.length;
            }

            return Promise.resolve();
        },
        remove: (ids, options) => {
            for (const id of ids) {
                removeDocument(options.namespace, id);
            }

            return Promise.resolve();
        },
        search: (query, options) => {
            const state = stateFor(options.namespace);
            const documentCount = state.documents.size;

            if (documentCount === 0) {
                return Promise.resolve([]);
            }

            const queryTerms = tokenizeQuery(query);

            if (queryTerms.length === 0) {
                return Promise.resolve([]);
            }

            const averageLength = state.totalLength / documentCount;
            const scores = new Map<string, number>();

            for (const term of queryTerms) {
                const posting = state.postings.get(term);

                if (!posting) {
                    continue;
                }

                const documentFrequency = posting.size;
                const idf = bm25Idf(documentCount, documentFrequency);

                for (const [id, frequency] of posting) {
                    const document = state.documents.get(id);

                    if (!document) {
                        continue;
                    }

                    // Honour the same metadata predicate the vector leg gets.
                    // A lexical hit that the filter excludes must never reach
                    // fusion: the filter carries the tenant/RBAC scope, and
                    // surfacing the chunk here would leak its text regardless of
                    // what the vector leg returned.
                    if (!matchesMetadataFilter(document.metadata, options.filter)) {
                        continue;
                    }

                    scores.set(id, (scores.get(id) ?? 0) + bm25TermScore(idf, frequency, document.length, averageLength));
                }
            }

            const matches: LexicalMatch[] = [...scores.entries()].map(([id, score]) => {
                return {
                    id,
                    score,
                    text: state.documents.get(id)?.text ?? "",
                };
            });

            return Promise.resolve(matches.toSorted((a, b) => b.score - a.score).slice(0, options.topK));
        },
    };

    return store;
};

export default bm25LexicalStore;
