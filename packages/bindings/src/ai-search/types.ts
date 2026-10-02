/**
 * Structural types for Cloudflare AI Search (formerly AutoRAG) — the
 * `ai_search_namespaces` binding `ctx.aiSearch` passes through unwrapped.
 *
 * Mirrored structurally, like every other `@lunora/bindings` subpath, rather than
 * aliased from `@cloudflare/workers-types`: `AiSearchNamespace` only ships in
 * workers-types 4.20260331.1+, and an alias resolved against an older (or
 * absent) install would silently degrade to `any` under `skipLibCheck`. The
 * mirror follows workers-types 5.20260929.1; a type test pins that the real
 * binding still satisfies it, so drift fails CI instead of the consumer.
 */

/** A single message in a conversation-style search or chat request. */
export interface AiSearchMessage {
    content: string | null;
    role: "assistant" | "developer" | "system" | "tool" | "user";
}

/** A scalar a metadata filter compares against. */
export type AiSearchFilterValue = boolean | number | string;

/**
 * Vectorize metadata filter applied to the retrieval: per field, an implicit
 * `$eq` value, or an operator object (`$eq`/`$ne`/`$lt`/`$lte`/`$gt`/`$gte`,
 * `$in`/`$nin`).
 */
export interface AiSearchFilter {
    [field: string]:
        | AiSearchFilterValue
        | {
              $eq?: AiSearchFilterValue | null;
              $gt?: AiSearchFilterValue | null;
              $gte?: AiSearchFilterValue | null;
              $lt?: AiSearchFilterValue | null;
              $lte?: AiSearchFilterValue | null;
              $ne?: AiSearchFilterValue | null;
          }
        | { $in?: AiSearchFilterValue[]; $nin?: AiSearchFilterValue[] }
        | null;
}

/** `ai_search_options` — retrieval, query rewrite, reranking and cache sub-options. */
export interface AiSearchOptions {
    [key: string]: unknown;
    cache?: {
        cache_threshold?: "anything_goes" | "close_enough" | "flexible_friend" | "super_strict_match";
        enabled?: boolean;
    };
    query_rewrite?: { [key: string]: unknown; enabled?: boolean; model?: string; rewrite_prompt?: string };
    reranking?: { [key: string]: unknown; enabled?: boolean; match_threshold?: number; model?: string };
    retrieval?: {
        [key: string]: unknown;
        /** Boost results by metadata field values. Max 3 entries. */
        boost_by?: { direction?: "asc" | "desc" | "exists" | "not_exists"; field: string }[];
        /** Number of surrounding chunks to include for context (0-3). Default 0. */
        context_expansion?: number;
        /** Vectorize metadata filters applied to the search. */
        filters?: AiSearchFilter;
        fusion_method?: "max" | "rrf";
        keyword_match_mode?: "and" | "or";
        /** Minimum similarity score (0-1) for a result to be included. Default 0.4. */
        match_threshold?: number;
        /** Maximum number of results to return (1-50). Default 10. */
        max_num_results?: number;
        metadata_only?: boolean;
        retrieval_type?: "hybrid" | "keyword" | "vector";
        /** If true (default), return empty results on retrieval failure instead of throwing. */
        return_on_failure?: boolean;
    };
}

/** Single-instance search: exactly one of `query` or `messages`. */
export type AiSearchSearchRequest =
    | { ai_search_options?: AiSearchOptions; messages: AiSearchMessage[]; query?: never }
    | { ai_search_options?: AiSearchOptions; messages?: never; query: string };

export interface AiSearchChatCompletionsRequest {
    [key: string]: unknown;
    ai_search_options?: AiSearchOptions;
    messages: AiSearchMessage[];
    model?: string;
    stream?: boolean;
}

/** One retrieved chunk. */
export interface AiSearchChunk {
    id: string;
    item: { key: string; metadata?: Record<string, unknown>; timestamp?: number };
    /** Match score (0-1). */
    score: number;
    scoring_details?: {
        [key: string]: unknown;
        fusion_method?: "max" | "rrf";
        keyword_rank?: number;
        keyword_score?: number;
        reranking_score?: number;
        vector_rank?: number;
        vector_score?: number;
    };
    text: string;
    type: string;
}

export interface AiSearchSearchResponse {
    chunks: AiSearchChunk[];
    search_query: string;
}

export interface AiSearchChatCompletionsResponse {
    [key: string]: unknown;
    choices: {
        [key: string]: unknown;
        index?: number;
        message: { [key: string]: unknown; content: string | null; role: "assistant" | "developer" | "system" | "tool" | "user" };
    }[];
    chunks: AiSearchChunk[];
    id?: string;
    model?: string;
    object?: string;
}

/** `ai_search_options` for a namespace-level (multi-instance) request — requires `instance_ids` (1-10). */
export type AiSearchMultiSearchOptions = AiSearchOptions & { instance_ids: string[] };

export type AiSearchMultiSearchRequest =
    | { ai_search_options: AiSearchMultiSearchOptions; messages: AiSearchMessage[]; query?: never }
    | { ai_search_options: AiSearchMultiSearchOptions; messages?: never; query: string };

/** A chunk tagged with the instance it came from. */
export type AiSearchMultiSearchChunk = AiSearchChunk & { instance_id: string };

/** A per-instance failure in a multi-instance call (the others still answer). */
export interface AiSearchMultiSearchError {
    instance_id: string;
    message: string;
}

export interface AiSearchMultiSearchResponse {
    chunks: AiSearchMultiSearchChunk[];
    errors?: AiSearchMultiSearchError[];
    search_query: string;
}

export type AiSearchMultiChatCompletionsRequest = Omit<AiSearchChatCompletionsRequest, "ai_search_options"> & {
    ai_search_options: AiSearchMultiSearchOptions;
};

export type AiSearchMultiChatCompletionsResponse = Omit<AiSearchChatCompletionsResponse, "chunks"> & {
    chunks: AiSearchMultiSearchChunk[];
    errors?: AiSearchMultiSearchError[];
};

/** Pagination envelope shared by the page-based list responses. */
export interface AiSearchResultInfo {
    count: number;
    page: number;
    per_page: number;
    total_count: number;
}

/**
 * Instance configuration (`create` / `update`). Only `id` is required; omit
 * `type` and `source` for built-in storage. Open-ended like Cloudflare's own
 * type, so the remaining knobs (models, chunking, caching, custom metadata) pass
 * through without being re-listed here.
 */
export interface AiSearchConfig {
    [key: string]: unknown;
    /** Instance ID (1-32 chars, `^[a-z0-9_]+(?:-[a-z0-9_]+)*$`). */
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    /** Source URL (required for the `web-crawler` type). */
    source?: string;
    type?: string;
}

/** Instance metadata (`info()`, `list()`, `update()`). */
export interface AiSearchInstanceInfo {
    [key: string]: unknown;
    created_at?: string;
    id: string;
    metadata?: Record<string, unknown>;
    modified_at?: string;
    namespace?: string;
    paused?: boolean;
    source?: string;
    status?: string;
    type?: string;
}

export interface AiSearchListInstancesParams {
    order_by?: "created_at";
    order_by_direction?: "asc" | "desc";
    page?: number;
    per_page?: number;
    /** Search instances by ID. */
    search?: string;
}

export interface AiSearchListResponse {
    result: AiSearchInstanceInfo[];
    result_info?: AiSearchResultInfo;
}

export interface AiSearchStatsResponse {
    completed?: number;
    engine?: {
        r2?: { metadataSizeBytes: number; objectCount: number; payloadSizeBytes: number };
        vectorize?: { dimensions: number; vectorsCount: number };
    };
    error?: number;
    last_activity?: string;
    outdated?: number;
    queued?: number;
    running?: number;
    skipped?: number;
}

/** One indexed item (a file in the instance's source). */
export interface AiSearchItemInfo {
    [key: string]: unknown;
    chunks_count?: number | null;
    created_at?: string;
    error?: string;
    id: string;
    key: string;
    metadata?: Record<string, unknown>;
    status: "completed" | "error" | "outdated" | "queued" | "running" | "skipped";
}

export interface AiSearchListItemsParams {
    item_id?: string;
    key?: string;
    /** JSON-encoded Vectorize filter for metadata filtering. */
    metadata_filter?: string;
    page?: number;
    per_page?: number;
    search?: string;
    sort_by?: "modified_at" | "status";
    source?: string;
    status?: "completed" | "error" | "outdated" | "queued" | "running" | "skipped";
}

export interface AiSearchListItemsResponse {
    result: AiSearchItemInfo[];
    result_info?: AiSearchResultInfo;
}

export interface AiSearchUploadItemOptions {
    metadata?: Record<string, unknown>;
}

/** One item: `info`, `download`, `sync` (re-index), `logs`, `chunks`. */
export interface AiSearchItem {
    chunks: (params?: { limit?: number; offset?: number }) => Promise<{
        result: {
            end_byte: number;
            id: string;
            item?: { key: string; metadata?: Record<string, unknown>; timestamp?: number };
            start_byte: number;
            text: string;
        }[];
        result_info: { count: number; limit: number; offset: number; total: number };
    }>;
    download: () => Promise<{ body: ReadableStream; contentType: string; filename: string; size: number }>;
    info: () => Promise<AiSearchItemInfo>;
    logs: (params?: { cursor?: string; limit?: number }) => Promise<{
        result: { action: string; chunkCount?: number; errorType?: string; fileKey?: string; message: string; processingTimeMs?: number; timestamp: string }[];
        result_info: { count: number; cursor: string | null; per_page: number; truncated: boolean };
    }>;
    sync: () => Promise<AiSearchItemInfo>;
}

/** An instance's items: `list`, `upload` (an upsert), `uploadAndPoll`, `get`, `delete`. */
export interface AiSearchItems {
    delete: (itemId: string) => Promise<void>;
    get: (itemId: string) => AiSearchItem;
    list: (params?: AiSearchListItemsParams) => Promise<AiSearchListItemsResponse>;
    upload: (name: string, content: Blob | ReadableStream | string, options?: AiSearchUploadItemOptions) => Promise<AiSearchItemInfo>;
    uploadAndPoll: (
        name: string,
        content: Blob | ReadableStream | string,
        options?: AiSearchUploadItemOptions & { pollIntervalMs?: number; timeoutMs?: number },
    ) => Promise<AiSearchItemInfo>;
}

export interface AiSearchJobInfo {
    description?: string;
    end_reason?: string;
    ended_at?: string;
    id: string;
    last_seen_at?: string;
    source: "schedule" | "user";
    started_at?: string;
}

/** One indexing job: `info`, `logs`, `cancel`. */
export interface AiSearchJob {
    cancel: () => Promise<AiSearchJobInfo>;
    info: () => Promise<AiSearchJobInfo>;
    logs: (params?: { page?: number; per_page?: number }) => Promise<{
        result: { created_at: number; id: number; message: string; message_type: number }[];
        result_info?: AiSearchResultInfo;
    }>;
}

/** An instance's indexing jobs: `list`, `create`, `get`. */
export interface AiSearchJobs {
    create: (params?: { description?: string }) => Promise<AiSearchJobInfo>;
    get: (jobId: string) => AiSearchJob;
    list: (params?: { page?: number; per_page?: number }) => Promise<{ result: AiSearchJobInfo[]; result_info?: AiSearchResultInfo }>;
}

/**
 * One AI Search instance — what `ctx.aiSearch.get(name)` returns: `search`,
 * `chatCompletions` (streaming with `stream: true`), `update`, `info`, `stats`,
 * plus the `items` and `jobs` collections.
 */
export interface AiSearchInstance {
    chatCompletions: {
        (params: AiSearchChatCompletionsRequest & { stream: true }): Promise<ReadableStream>;
        (params: AiSearchChatCompletionsRequest): Promise<AiSearchChatCompletionsResponse>;
    };
    info: () => Promise<AiSearchInstanceInfo>;
    readonly items: AiSearchItems;
    readonly jobs: AiSearchJobs;
    search: (params: AiSearchSearchRequest) => Promise<AiSearchSearchResponse>;
    stats: () => Promise<AiSearchStatsResponse>;
    update: (config: Partial<AiSearchConfig>) => Promise<AiSearchInstanceInfo>;
}

/**
 * The AI Search namespace binding (`ai_search_namespaces` in wrangler) —
 * `get(name)` an instance, `list` / `create` / `delete` instances, or run a
 * multi-instance `search` / `chatCompletions` over up to 10 `instance_ids`.
 */
export interface AiSearch {
    chatCompletions: {
        (params: AiSearchMultiChatCompletionsRequest & { stream: true }): Promise<ReadableStream>;
        (params: AiSearchMultiChatCompletionsRequest): Promise<AiSearchMultiChatCompletionsResponse>;
    };
    create: (config: AiSearchConfig) => Promise<AiSearchInstance>;
    delete: (name: string) => Promise<void>;
    get: (name: string) => AiSearchInstance;
    list: (params?: AiSearchListInstancesParams) => Promise<AiSearchListResponse>;
    search: (params: AiSearchMultiSearchRequest) => Promise<AiSearchMultiSearchResponse>;
}
