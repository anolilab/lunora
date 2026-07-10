import { LunoraError } from "@lunora/errors";

import { concurrentMap, UPSERT_EMBED_CONCURRENCY } from "./concurrent";
import type {
    LunoraVectors,
    LunoraVectorsOptions,
    QueryInput,
    UpsertInput,
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatches,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "./types";

const resolveIndex = (indexes: Record<string, VectorizeIndexLike>, name: string): VectorizeIndexLike => {
    // Own-property check, not truthiness: a prototype key ("__proto__",
    // "constructor", …) would otherwise resolve to an inherited Object.prototype
    // member and slip past the not-found guard. Object.hasOwn keeps unknown
    // names (including prototype keys) on the controlled LunoraError path.
    const index = indexes[name];

    if (!Object.hasOwn(indexes, name) || index === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/bindings/vectors: no index registered for "${name}". Known indexes: ${Object.keys(indexes).join(", ") || "(none)"}`,
        );
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

/**
 * Vectorize lowers the `topK` ceiling to 20 when a query also asks for the
 * vector values (`returnValues: true`) or full metadata (`returnMetadata:
 * "all"`) — the larger 100 cap only applies to id/score-only queries. We
 * enforce the tighter bound locally so a `topK: 50, returnValues: true` call
 * fails with a clear error instead of being silently capped (or rejected)
 * remotely.
 */
const MAX_TOP_K_WITH_VALUES = 20;

/** Vectorize hard ceiling on the `ids` array for batched id lookups. */
const MAX_ID_BATCH = 1000;

/** Vectorize hard ceiling on a single `upsertMany` batch. */
const MAX_UPSERT_BATCH = 1000;

const createVectors = (options: LunoraVectorsOptions): LunoraVectors => {
    if (Object.keys(options.indexes).length === 0) {
        throw new TypeError("@lunora/bindings/vectors: at least one index binding is required");
    }

    const upsert = async <TInput>(indexName: string, input: UpsertInput<TInput>): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);
        const vector = await toVector(input);

        return index.upsert([vector]);
    };

    const upsertMany = async <TInput>(indexName: string, inputs: ReadonlyArray<UpsertInput<TInput>>): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);

        if (inputs.length > MAX_UPSERT_BATCH) {
            throw new RangeError(
                `@lunora/bindings/vectors: upsertMany batch exceeds ${String(MAX_UPSERT_BATCH)} (got ${String(inputs.length)}) — split across calls`,
            );
        }

        // Bound the parallel embedder fan-out so a 1000-vector batch doesn't
        // spawn 1000 concurrent embedder calls (which typically hits a remote
        // provider and would otherwise rate-limit or DoS the embedder).
        const vectors = await concurrentMap(inputs, UPSERT_EMBED_CONCURRENCY, toVector);

        return index.upsert(vectors);
    };

    const query = async <TInput>(indexName: string, input: QueryInput<TInput>): Promise<VectorizeMatches> => {
        const index = resolveIndex(options.indexes, indexName);

        // The ceiling depends on what the query returns: 20 when values or full
        // metadata are requested, 100 otherwise.
        const wantsHeavyPayload = input.returnValues === true || input.returnMetadata === "all";
        const topKCeiling = wantsHeavyPayload ? MAX_TOP_K_WITH_VALUES : MAX_TOP_K;

        if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > topKCeiling)) {
            const reason = wantsHeavyPayload ? ' (lowered to 20 because returnValues/returnMetadata:"all" is set)' : "";

            throw new RangeError(`@lunora/bindings/vectors: topK must be an integer in [1, ${String(topKCeiling)}]${reason} (got ${String(input.topK)})`);
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
                throw new TypeError("@lunora/bindings/vectors: query requires either `vector` or both `input` and `embed`");
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
            throw new RangeError(`@lunora/bindings/vectors: getByIds accepts at most ${String(MAX_ID_BATCH)} ids (got ${String(ids.length)})`);
        }

        return index.getByIds(ids);
    };

    const deleteByIds = async (indexName: string, ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
        const index = resolveIndex(options.indexes, indexName);

        if (ids.length > MAX_ID_BATCH) {
            throw new RangeError(`@lunora/bindings/vectors: deleteByIds accepts at most ${String(MAX_ID_BATCH)} ids (got ${String(ids.length)})`);
        }

        return index.deleteByIds(ids);
    };

    const describe = async (indexName: string): Promise<VectorizeIndexDetails> => {
        const index = resolveIndex(options.indexes, indexName);

        if (!index.describe) {
            throw new LunoraError("INTERNAL", `@lunora/bindings/vectors: binding for "${indexName}" does not implement describe()`);
        }

        return index.describe();
    };

    return { deleteByIds, describe, getByIds, query, upsert, upsertMany };
};

export default createVectors;
