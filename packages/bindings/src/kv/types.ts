import type { KvGetOptions, KvListKey, KVNamespaceLike } from "@lunora/platform";

/** Construction options for the `createKv` factory. */
export interface LunoraKvOptions {
    /**
     * Optional per-instance key prefix applied to every operation (get/put/
     * delete/list). Use for multi-tenant key namespacing — equivalent to
     * calling the `scopeKey` helper on every key. Combined via `scopeKey`, so a
     * `..` or NUL in the prefix is rejected.
     */
    keyPrefix?: string;
    /** The bound KV namespace (`env.&lt;BINDING>`). */
    namespace: KVNamespaceLike;
}

/** Options for {@link Kv.put}. JSON-stringifies the value unless `raw` is set. */
export interface KvPutOptions {
    /** Absolute expiration as a Unix timestamp (seconds). Mutually exclusive with `expirationTtl`. */
    expiration?: number;
    /** Relative expiration in seconds from now (minimum 60). Mutually exclusive with `expiration`. */
    expirationTtl?: number;
    /** Arbitrary metadata stored alongside the value (returned by `getWithMetadata`/`list`). */
    metadata?: unknown;

    /**
     * When true, write `value` to KV verbatim (no `JSON.stringify`). `value`
     * must already be a KV-writable type (string/ArrayBuffer/stream).
     */
    raw?: boolean;
}

/** Options for {@link Kv.list}. */
export interface KvListOptions {
    /** Opaque cursor from a previous truncated page. */
    cursor?: string;
    /** Max keys per page (KV caps at 1000). */
    limit?: number;
    /** Restrict to keys starting with this prefix (combined with any `keyPrefix`). */
    prefix?: string;
}

/** A single page of {@link Kv.list} results. */
export interface KvListResult<Metadata = unknown> {
    /** Cursor for the next page; `undefined` when the listing is complete. */
    cursor?: string;

    /**
     * The key names, with any instance `keyPrefix` stripped back off so callers
     * see the same keys they wrote.
     */
    keys: KvListKey<Metadata>[];
    /** True when this is the final page (no further `cursor`). */
    listComplete: boolean;
}

/** A value together with its stored metadata (from {@link Kv.getWithMetadata}). */
export interface KvValueWithMetadata<Value, Metadata> {
    /** The stored metadata, or `null` when none was set / the key is absent. */
    metadata: Metadata | null;
    /** The decoded value, or `null` when the key is absent. */
    value: Value | null;
}

/**
 * The typed Workers KV client bound to `ctx.kv`. JSON-decodes/encodes by
 * default; a raw escape hatch ({@link Kv.getRaw} / `put(..., { raw: true })`)
 * handles text/binary/stream values.
 */
export interface Kv {
    /** Delete a key. No-op if absent. */
    delete: (key: string) => Promise<void>;

    /**
     * Read a key and `JSON.parse` it into `T`. Returns `null` when the key is
     * absent. Throws if the stored value isn't valid JSON — use
     * {@link Kv.getRaw} for non-JSON values.
     */
    get: <T = unknown>(key: string, options?: { cacheTtl?: number }) => Promise<T | null>;

    /** Read a raw value with an explicit decode `type` (default `"text"`). Returns `null` when absent. */
    getRaw: <T = string>(key: string, options?: KvGetOptions) => Promise<T | null>;

    /**
     * Read a key's JSON value together with its metadata. Returns
     * `{ value: null, metadata: null }` when the key is absent.
     */
    getWithMetadata: <T = unknown, M = unknown>(key: string, options?: { cacheTtl?: number }) => Promise<KvValueWithMetadata<T, M>>;

    /** List keys (optionally `prefix`-filtered, paginated via `cursor`). */
    list: <M = unknown>(options?: KvListOptions) => Promise<KvListResult<M>>;

    /**
     * Write `value` to `key`. JSON-stringifies `value` unless `options.raw` is
     * set (in which case `value` must be a KV-writable type). Forwards
     * `expirationTtl`/`expiration`/`metadata` to the binding.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public `put<T>` generic kept for caller ergonomics/symmetry with `get<T>`
    put: <T = unknown>(key: string, value: T, options?: KvPutOptions) => Promise<void>;
}

export {
    type KvGetOptions,
    type KvListKey,
    type KVNamespaceLike,
    type KvNamespaceListResult,
    type KvNamespacePutOptions,
    type KvValue,
    type KvValueType,
} from "@lunora/platform";
