/**
 * `ctx.aiSearch` — Cloudflare AI Search (formerly AutoRAG), typed.
 *
 * Types only, by design: `ctx.aiSearch` IS the `ai_search_namespaces` binding,
 * passed through unwrapped, so there is no facade to construct. The subpath
 * gives the generated `ActionCtx` a module specifier to name the binding
 * through, instead of an ambient global an app whose tsconfig does not load
 * `@cloudflare/workers-types` would not see.
 */
export type {
    AiSearch,
    AiSearchChatCompletionsRequest,
    AiSearchChatCompletionsResponse,
    AiSearchChunk,
    AiSearchConfig,
    AiSearchFilter,
    AiSearchFilterValue,
    AiSearchInstance,
    AiSearchInstanceInfo,
    AiSearchItem,
    AiSearchItemInfo,
    AiSearchItems,
    AiSearchJob,
    AiSearchJobInfo,
    AiSearchJobs,
    AiSearchListInstancesParams,
    AiSearchListItemsParams,
    AiSearchListItemsResponse,
    AiSearchListResponse,
    AiSearchMessage,
    AiSearchMultiChatCompletionsRequest,
    AiSearchMultiChatCompletionsResponse,
    AiSearchMultiSearchChunk,
    AiSearchMultiSearchError,
    AiSearchMultiSearchOptions,
    AiSearchMultiSearchRequest,
    AiSearchMultiSearchResponse,
    AiSearchOptions,
    AiSearchResultInfo,
    AiSearchSearchRequest,
    AiSearchSearchResponse,
    AiSearchStatsResponse,
    AiSearchUploadItemOptions,
} from "./types";
