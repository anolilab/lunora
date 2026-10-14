/**
 * Types and endpoint constants shared by the export and import halves of
 * `lunora export` / `lunora import`.
 */

const EXPORT_ENDPOINT_PATH = "/_lunora/admin/export";
const IMPORT_ENDPOINT_PATH = "/_lunora/admin/import";
const STORAGE_ENDPOINT_PATH = "/_lunora/admin/storage";
const STORAGE_URL_ENDPOINT_PATH = "/_lunora/admin/storage/url";

/**
 * Minimal projection of `globalThis.fetch` for the transfer commands: `body` is
 * exposed as a stream-iterable (the export path pipes it) and accepts bytes (the
 * blob path uploads them). The JSON-only commands use the narrower `FetchLike`
 * in `../run/handler` instead.
 */
type StreamingFetchLike = (
    input: string,
    init?: { body?: string | Uint8Array; headers?: Record<string, string>; method?: string },
) => Promise<{
    /** Optional: only the storage transfer reads raw bytes, and only real `fetch` needs to supply it. */
    arrayBuffer?: () => Promise<ArrayBuffer>;
    body: ReadableStream<Uint8Array> | null;
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;

export type { StreamingFetchLike };
export { EXPORT_ENDPOINT_PATH, IMPORT_ENDPOINT_PATH, STORAGE_ENDPOINT_PATH, STORAGE_URL_ENDPOINT_PATH };
