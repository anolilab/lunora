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
        values,
        metadata: input.metadata,
        namespace: input.namespace,
    };
};

export const createVectors = (options: CirrusVectorsOptions): CirrusVectors => {
    if (!options.indexes || Object.keys(options.indexes).length === 0) {
        throw new Error("@cirrus/vectors: at least one index binding is required");
    }

    const upsert = async <TInput>(indexName: string, input: UpsertInput<TInput>): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);
        const vector = await toVector(input);

        return index.upsert([vector]);
    };

    const upsertMany = async <TInput>(
        indexName: string,
        inputs: ReadonlyArray<UpsertInput<TInput>>,
    ): Promise<VectorizeUpsertMutation> => {
        const index = resolveIndex(options.indexes, indexName);
        const vectors = await Promise.all(inputs.map(toVector));

        return index.upsert(vectors);
    };

    const query = async <TInput>(indexName: string, input: QueryInput<TInput>): Promise<VectorizeMatches> => {
        const index = resolveIndex(options.indexes, indexName);
        let values: ReadonlyArray<number>;

        if (input.vector) {
            values = input.vector;
        } else {
            if (!input.embed || input.input === undefined) {
                throw new Error("@cirrus/vectors: query requires either `vector` or both `input` and `embed`");
            }

            values = await input.embed(input.input);
        }

        return index.query(values, {
            topK: input.topK,
            returnValues: input.returnValues,
            returnMetadata: input.returnMetadata,
            namespace: input.namespace,
            filter: input.filter,
        });
    };

    const getByIds = async (indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> => {
        const index = resolveIndex(options.indexes, indexName);

        return index.getByIds(ids);
    };

    const deleteByIds = async (indexName: string, ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
        const index = resolveIndex(options.indexes, indexName);

        return index.deleteByIds(ids);
    };

    const describe = async (indexName: string): Promise<VectorizeIndexDetails> => {
        const index = resolveIndex(options.indexes, indexName);

        if (!index.describe) {
            throw new Error(`@cirrus/vectors: binding for "${indexName}" does not implement describe()`);
        }

        return index.describe();
    };

    return { upsert, upsertMany, query, getByIds, deleteByIds, describe };
};
