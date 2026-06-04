import type {
    CirrusVectors,
    CirrusVectorsOptions,
    QueryInput,
    UpsertInput,
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatches,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "./types.js";

import { concurrentMap, UPSERT_EMBED_CONCURRENCY } from "./concurrent.js";

const resolveIndex = (indexes: Record<string, VectorizeIndexLike>, name: string): VectorizeIndexLike => {
    const index = indexes[name];

    if (!index) {
        throw new Error(`@cirrus/vectors: no index registered for "${name}". Known indexes: ${Object.keys(indexes).join(", ") || "(none)"}`);
    }

    return index;
};

const toVector = async <TInput>(input: UpsertInput<TInput>): Promise<VectorizeVector> => {
    const values = await input.embed(input.input);

    return {
        id: input.id,
        metadata: input.metadata,
        namespace: input.namespace,
        values,
    };
};

/** Vectorize hard ceiling on `topK` per query. */
const MAX_TOP_K = 100;

/** Vectorize hard ceiling on the `ids` array for batched id lookups. */
const MAX_ID_BATCH = 1000;

/** Vectorize hard ceiling on a single `upsertMany` batch. */
const MAX_UPSERT_BATCH = 1000;

export const createVectors = (options: CirrusVectorsOptions): CirrusVectors => {
    if (!options.indexes || Object.keys(options.indexes).length === 0) {
        throw new Error("@cirrus/vectors: at least one index binding is required");
    }

    const upsert = async <TInput>(indexName: string, input: UpsertInput<TInput>): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);
        const vector = await toVector(input);

        return index.upsert([vector]);
    };

    const upsertMany = async <TInput>(indexName: string, inputs: ReadonlyArray<UpsertInput<TInput>>): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);

        if (inputs.length > MAX_UPSERT_BATCH) {
            throw new RangeError(`@cirrus/vectors: upsertMany batch exceeds ${String(MAX_UPSERT_BATCH)} (got ${String(inputs.length)}) — split across calls`);
        }

        // Bound the parallel embedder fan-out so a 1000-vector batch doesn't
        // spawn 1000 concurrent embedder calls (which typically hits a remote
        // provider and would otherwise rate-limit or DoS the embedder).
        const vectors = await concurrentMap(inputs, UPSERT_EMBED_CONCURRENCY, toVector);

        return index.upsert(vectors);
    };

    const query = async <TInput>(indexName: string, input: QueryInput<TInput>): Promise<VectorizeMatches> => {
        const index = resolveIndex(options.indexes, indexName);

        if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > MAX_TOP_K)) {
            throw new RangeError(`@cirrus/vectors: topK must be an integer in [1, ${String(MAX_TOP_K)}] (got ${String(input.topK)})`);
        }

        let values: ReadonlyArray<number>;

        // Guard on length, not truthiness: an empty `[]` is truthy but is not a
        // usable query vector. Falling through to the embed branch yields the
        // descriptive local error instead of an opaque remote Vectorize reject,
        // and an accidental empty array no longer silently skips the embedder.
        if (input.vector && input.vector.length > 0) {
            values = input.vector;
        } else {
            if (!input.embed || input.input === undefined) {
                throw new Error("@cirrus/vectors: query requires either `vector` or both `input` and `embed`");
            }

            values = await input.embed(input.input);
        }

        return index.query(values, {
            filter: input.filter,
            namespace: input.namespace,
            returnMetadata: input.returnMetadata,
            returnValues: input.returnValues,
            topK: input.topK,
        });
    };

    const getByIds = async (indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> => {
        const index = resolveIndex(options.indexes, indexName);

        if (ids.length > MAX_ID_BATCH) {
            throw new RangeError(`@cirrus/vectors: getByIds accepts at most ${String(MAX_ID_BATCH)} ids (got ${String(ids.length)})`);
        }

        return index.getByIds(ids);
    };

    const deleteByIds = async (indexName: string, ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
        const index = resolveIndex(options.indexes, indexName);

        if (ids.length > MAX_ID_BATCH) {
            throw new RangeError(`@cirrus/vectors: deleteByIds accepts at most ${String(MAX_ID_BATCH)} ids (got ${String(ids.length)})`);
        }

        return index.deleteByIds(ids);
    };

    const describe = async (indexName: string): Promise<VectorizeIndexDetails> => {
        const index = resolveIndex(options.indexes, indexName);

        if (!index.describe) {
            throw new Error(`@cirrus/vectors: binding for "${indexName}" does not implement describe()`);
        }

        return index.describe();
    };

    return { deleteByIds, describe, getByIds, query, upsert, upsertMany };
};
