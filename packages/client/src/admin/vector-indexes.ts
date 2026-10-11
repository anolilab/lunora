import { VECTOR_INDEXES_PATH, VECTOR_QUERY_PATH } from "../client-paths";
import type { VectorIndexSummary, VectorQueryMatch } from "../types";
import type { AdminHost } from "./host";

export const listVectorIndexes = async (host: AdminHost): Promise<VectorIndexSummary[]> => {
    host.assertOpen();

    const body = (await host.adminFetch(VECTOR_INDEXES_PATH, "GET")) as { indexes?: VectorIndexSummary[] };

    return body.indexes ?? [];
};

export const queryVectorIndex = async (host: AdminHost, options: { name: string; text: string; topK?: number }): Promise<VectorQueryMatch[]> => {
    host.assertOpen();

    const body = (await host.adminFetch(VECTOR_QUERY_PATH, "POST", options)) as { matches?: VectorQueryMatch[] };

    return body.matches ?? [];
};
