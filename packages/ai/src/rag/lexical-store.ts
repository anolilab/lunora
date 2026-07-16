import type { LexicalMatch, RagLexicalStore } from "./types";

/**
 * Okapi BM25 term-saturation constant. 1.5 is the standard default — higher
 * values reward repeated terms more, lower values saturate sooner.
 */
const BM25_K1 = 1.5;
/** Okapi BM25 length-normalization constant (0 = off, 1 = full). 0.75 is the standard default. */
const BM25_B = 0.75;

/** Lowercase and split into `[a-z0-9]+` tokens — dependency-free, adequate for keyword recall. */
const TOKEN_PATTERN = /[a-z0-9]+/g;

const tokenize = (text: string): string[] => text.toLowerCase().match(TOKEN_PATTERN) ?? [];

/** One indexed chunk in a namespace's BM25 state. */
interface Bm25Document {
    length: number;
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
 * Whether a stored metadata record satisfies a flat-equality filter. Only
 * primitive-valued filter entries are evaluated; a Vectorize operator object
 * (e.g. `{ $ne: … }`) is not understood by this reference store — see the
 * fail-closed note on {@link bm25LexicalStore}.
 */
const isPrimitiveFilter = (filter: Record<string, unknown>): boolean => Object.values(filter).every((value) => value === null || typeof value !== "object");

/** Already-warned reference stores (deduped per instance) — a one-time dev signal, not per-query spam. */
const filterWarned = new WeakSet<object>();

/**
 * An **in-memory** Okapi BM25 lexical store — the reference adapter behind
 * `RagConfig.lexicalStore`, giving hybrid retrieval its keyword leg with zero
 * infrastructure. State lives in the worker isolate: it is **not durable and not
 * shared across isolates**, so it is intended for tests, local development, and
 * single-isolate workloads. Production deployments plug a durable
 * {@link RagLexicalStore} (a DO-SQLite inverted index, D1, or an external search
 * service) behind the same seam.
 *
 * Tenant isolation is by `namespace` (each namespace keeps its own index). This
 * store holds **no metadata**, so it cannot evaluate a metadata `filter`
 * (including an `rlsFilter` result): when `search` is called with a non-empty
 * filter it **fails closed** — returns no lexical hits and warns once — rather
 * than risk surfacing a row the filter would exclude. If your RLS is
 * metadata-based (not namespace-based) and you want a lexical leg, fold the RLS
 * dimension into the `namespace` or plug a filter-aware store.
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

                state.documents.set(chunk.id, { length: tokens.length, termFrequency, text: chunk.text });
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
            // No metadata here → cannot honour a metadata/RLS filter. Fail closed.
            if (options.filter && Object.keys(options.filter).length > 0 && !isPrimitiveFilter(options.filter)) {
                if (!filterWarned.has(store)) {
                    filterWarned.add(store);

                    // eslint-disable-next-line no-console
                    console.warn(
                        "[@lunora/ai/rag] bm25LexicalStore cannot evaluate a metadata filter (it stores no metadata);\n" +
                            "the lexical leg is skipped for filtered queries. Fold the RLS dimension into `namespace`,\n" +
                            "or plug a filter-aware RagLexicalStore, to keep a lexical leg under metadata-based RLS.",
                    );
                }

                return Promise.resolve([]);
            }

            const state = stateFor(options.namespace);
            const documentCount = state.documents.size;

            if (documentCount === 0) {
                return Promise.resolve([]);
            }

            const queryTerms = [...new Set(tokenize(query))];

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
                // BM25 "plus" IDF — always non-negative, so a common term never subtracts score.
                const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

                for (const [id, frequency] of posting) {
                    const document = state.documents.get(id);

                    if (!document) {
                        continue;
                    }

                    const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * document.length) / averageLength);
                    const contribution = idf * ((frequency * (BM25_K1 + 1)) / denominator);

                    scores.set(id, (scores.get(id) ?? 0) + contribution);
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
