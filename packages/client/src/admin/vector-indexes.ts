import { VECTOR_INDEXES_PATH, VECTOR_QUERY_PATH } from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { VectorIndexSummary, VectorQueryMatch } from "../types";
import type { AdminHost } from "./host";

export const listVectorIndexes = async (host: AdminHost): ReturnType<LunoraClient["listVectorIndexes"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(VECTOR_INDEXES_PATH, "GET")) as { indexes?: VectorIndexSummary[] };

    return body.indexes ?? [];
};

export const queryVectorIndex = async (
    host: AdminHost,
    options: Parameters<LunoraClient["queryVectorIndex"]>[0],
): ReturnType<LunoraClient["queryVectorIndex"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(VECTOR_QUERY_PATH, "POST", options)) as { matches?: VectorQueryMatch[] };

    return body.matches ?? [];
};
