import { LunoraError } from "@lunora/errors";

import type {
    Kv,
    KvGetOptions,
    KvListKey,
    KvListOptions,
    KvListResult,
    KvNamespacePutOptions,
    KvPutOptions,
    KvValue,
    KvValueWithMetadata,
    LunoraKvOptions,
} from "./types";

/** Workers KV's documented key-length ceiling (512 bytes). */
const MAX_KEY_LENGTH = 512;

/** Workers KV's documented per-page list ceiling. */
const MAX_LIST_LIMIT = 1000;

/**
 * Workers KV's documented ceiling on a key's attached metadata: 1,024 bytes of
 * serialized JSON. Checked before the round-trip so an oversized metadata object
 * fails here, naming the limit, rather than as a rejected `put` from the remote.
 */
const MAX_METADATA_LENGTH = 1024;

/** Shared encoder for measuring UTF-8 byte length (not UTF-16 `String.length`). */
const TEXT_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of a key. KV's ceiling is documented in **bytes**, so a key
 * of multi-byte (CJK/emoji) characters can be well under 512 UTF-16 code units
 * yet exceed 512 bytes — `String.length` would wave it through only to have KV
 * reject it remotely, defeating the fail-fast intent.
 */
const byteLength = (value: string): number => TEXT_ENCODER.encode(value).length;

/**
 * The NUL/`..`/length rules shared by keys and list prefixes. `.` and `..` are
 * reserved by KV's list semantics and traversal; reject them as path components
 * (not just substrings) so `a..b` is fine but `a/../b`, `../b`, `b/..`, `.` are
 * rejected.
 */
const validateSegments = (value: string, kind: "key" | "prefix"): void => {
    if (byteLength(value) > MAX_KEY_LENGTH) {
        throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: ${kind} exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    if (value.includes("\0")) {
        throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: ${kind} contains NUL byte`);
    }

    for (const segment of value.split("/")) {
        if (segment === "." || segment === "..") {
            throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: ${kind} contains a \`.\`/\`..\` path component`);
        }
    }
};

/**
 * Reject keys that escape their tenant prefix, contain a path-traversal
 * segment, or exceed KV's size ceiling. Mirrors `@lunora/storage`'s
 * `validateKey`. Used by every operation that takes a `key` so a malicious
 * caller can't probe peer prefixes via `..`, an empty string, or a NUL byte.
 *
 * Note: this does not enforce tenancy. Callers MUST also scope keys with a
 * per-tenant prefix (see {@link scopeKey} / {@link LunoraKvOptions.keyPrefix})
 * to prevent IDOR across tenants.
 */
const validateKey = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("@lunora/bindings/kv: key must be a non-empty string");
    }

    validateSegments(key, "key");
};

/**
 * Validate a `list` prefix with the same NUL/`..`/length rules as a key, but
 * allow the empty string (an empty prefix means "list everything"). Applied to
 * the caller-supplied list prefix combined with any instance scope so it honors
 * the same key-rejection contract as get/put/delete.
 */
const validatePrefix = (prefix: string): void => {
    if (prefix.length > 0) {
        validateSegments(prefix, "prefix");
    }
};

/**
 * Compose a per-tenant key from a scope prefix and a caller-supplied key. Both
 * halves are validated — the prefix may not contain `..` or NUL either, and the
 * resulting key must stay under KV's length ceiling. Recommended for any
 * multi-tenant deployment so client-supplied keys can't address peer data.
 * Mirrors `scopeKey` from `@lunora/storage`.
 */
// eslint-disable-next-line import/exports-last -- this exported helper must precede its consumer (`createKv`'s `resolve`) to avoid no-use-before-define
export const scopeKey = (prefix: string, key: string): string => {
    validateKey(prefix);
    validateKey(key);

    const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const composed = `${trimmedPrefix}/${key}`;

    if (byteLength(composed) > MAX_KEY_LENGTH) {
        throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: scoped key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    return composed;
};

/**
 * `expiration` (absolute Unix seconds) and `expirationTtl` (relative seconds)
 * are mutually exclusive. Nothing downstream enforces that: the binding type
 * declares both as optional siblings, and the KV implementation resolves the
 * pair by taking `expirationTtl` and dropping `expiration` on the floor
 * (miniflare's `validatePutOptions` reads `expiration` only in the `else`
 * branch). A caller that sends both therefore gets a silently different expiry
 * than it asked for, so reject the pair here — on every path that reaches a
 * `put`, not just this one.
 */
const assertOneExpirationForm = (options: { expiration?: number; expirationTtl?: number }): void => {
    if (options.expiration !== undefined && options.expirationTtl !== undefined) {
        throw new LunoraError("BAD_REQUEST", "@lunora/bindings/kv: `expiration` and `expirationTtl` are mutually exclusive");
    }
};

/**
 * Reject metadata KV would refuse: not JSON-serializable, or over the
 * 1,024-byte serialized ceiling. Checked before the round-trip so the failure
 * names the limit instead of surfacing as whatever the binding raises — on
 * every path that reaches a `put`, the studio's KV browser included.
 */
const assertMetadataWithinLimit = (metadata: unknown): void => {
    // `JSON.stringify` throws on a bigint or a cycle. Catching it keeps this
    // guard from replacing one cryptic failure with another: a raw `TypeError`
    // out of an options builder is exactly what the byte check below exists to
    // avoid.
    let encoded: string;

    try {
        encoded = JSON.stringify(metadata);
    } catch {
        throw new LunoraError("BAD_REQUEST", "@lunora/bindings/kv: metadata is not JSON-serializable (cyclic value, bigint, or similar)");
    }

    // A value JSON drops entirely (a function, a symbol) stringifies to
    // `undefined` despite the type saying otherwise; it measures small, passes,
    // and reaches the binding unchanged — as it did before this guard.
    if (byteLength(encoded) > MAX_METADATA_LENGTH) {
        throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: metadata exceeds ${String(MAX_METADATA_LENGTH)}-byte limit`);
    }
};

/** Build the raw KV put options from the public {@link KvPutOptions}, dropping `undefined`s. */
const toPutOptions = (options: KvPutOptions): KvNamespacePutOptions | undefined => {
    const out: KvNamespacePutOptions = {};

    assertOneExpirationForm(options);

    if (options.expiration !== undefined) {
        out.expiration = options.expiration;
    }

    if (options.expirationTtl !== undefined) {
        out.expirationTtl = options.expirationTtl;
    }

    if (options.metadata !== undefined) {
        assertMetadataWithinLimit(options.metadata);

        out.metadata = options.metadata;
    }

    return Object.keys(out).length > 0 ? out : undefined;
};

export const createKv = (options: LunoraKvOptions): Kv => {
    // Defensive runtime guard: `namespace` is required by the type, but JS
    // callers (and `createKv({})` misuse — exercised by a test) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.namespace) {
        throw new TypeError("@lunora/bindings/kv: `namespace` is required");
    }

    const { keyPrefix, namespace } = options;

    // Validate the instance `keyPrefix` once up front. `resolve` (get/put/delete)
    // re-validates it via `scopeKey`, but `list` builds its base prefix straight
    // from `keyPrefix` and would otherwise skip the `..`/NUL/length checks — so a
    // malformed prefix could silently leak into a list query. Validating here
    // keeps every path consistent and honors the documented contract.
    if (keyPrefix !== undefined) {
        validateKey(keyPrefix);
    }

    // Compose the instance `keyPrefix` (if any) with a caller key once per call.
    const resolve = (key: string): string => {
        if (keyPrefix === undefined) {
            validateKey(key);

            return key;
        }

        return scopeKey(keyPrefix, key);
    };

    // Strip the instance prefix back off a listed key so callers see what they wrote.
    const stripPrefix = (name: string): string => {
        if (keyPrefix === undefined) {
            return name;
        }

        const trimmed = keyPrefix.endsWith("/") ? keyPrefix : `${keyPrefix}/`;

        return name.startsWith(trimmed) ? name.slice(trimmed.length) : name;
    };

    const get = async <T = unknown>(key: string, getOptions: { cacheTtl?: number } = {}): Promise<T | null> => {
        const value = (await namespace.get(resolve(key), { cacheTtl: getOptions.cacheTtl, type: "json" })) as T | null;

        // eslint-disable-next-line unicorn/no-null -- mirrors the Cloudflare KV API contract: `.get()` returns `null` for a missing key
        return value ?? null;
    };

    const getRaw = async <T = string>(key: string, getOptions: KvGetOptions = {}): Promise<T | null> => {
        const value = (await namespace.get(resolve(key), { cacheTtl: getOptions.cacheTtl, type: getOptions.type ?? "text" })) as T | null;

        // eslint-disable-next-line unicorn/no-null -- mirrors the Cloudflare KV API contract: `.get()` returns `null` for a missing key
        return value ?? null;
    };

    const getWithMetadata = async <T = unknown, M = unknown>(key: string, getOptions: { cacheTtl?: number } = {}): Promise<KvValueWithMetadata<T, M>> => {
        const result = await namespace.getWithMetadata(resolve(key), { cacheTtl: getOptions.cacheTtl, type: "json" });

        // eslint-disable-next-line unicorn/no-null -- mirrors the Cloudflare KV API contract: `getWithMetadata` returns `null` for missing value/metadata
        return { metadata: (result.metadata as M | null) ?? null, value: (result.value as T | null) ?? null };
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public `put<T>` generic kept for caller ergonomics/symmetry with `get<T>`
    const put = async <T = unknown>(key: string, value: T, putOptions: KvPutOptions = {}): Promise<void> => {
        const body = putOptions.raw ? (value as unknown as KvValue) : JSON.stringify(value);

        await namespace.put(resolve(key), body, toPutOptions(putOptions));
    };

    const deleteKey = async (key: string): Promise<void> => {
        await namespace.delete(resolve(key));
    };

    const list = async <M = unknown>(listOptions: KvListOptions = {}): Promise<KvListResult<M>> => {
        // Reject a non-positive or non-integer limit loudly rather than silently
        // coercing it (a `limit: 0` previously yielded a 1-row page). The upper
        // bound is still clamped to KV's per-page ceiling below.
        if (listOptions.limit !== undefined && (!Number.isInteger(listOptions.limit) || listOptions.limit <= 0)) {
            throw new TypeError("@lunora/bindings/kv: `limit` must be a positive integer");
        }

        // Combine the instance keyPrefix with a caller-supplied prefix so a
        // scoped instance only ever lists its own keys. Validate the caller's
        // prefix (and the composed scope) with the same NUL/`..`/length rules as
        // a key so a malicious caller can't probe peer prefixes via `..`.
        let { prefix } = listOptions;

        if (prefix !== undefined) {
            validatePrefix(prefix);
        }

        if (keyPrefix !== undefined) {
            const base = keyPrefix.endsWith("/") ? keyPrefix : `${keyPrefix}/`;

            prefix = listOptions.prefix === undefined ? base : `${base}${listOptions.prefix}`;
            validatePrefix(prefix);
        }

        const limit = listOptions.limit === undefined ? undefined : Math.min(listOptions.limit, MAX_LIST_LIMIT);
        const result = await namespace.list({ cursor: listOptions.cursor, limit, prefix });

        const keys: KvListKey<M>[] = result.keys.map((entry) => {
            return {
                ...(entry as KvListKey<M>),
                name: stripPrefix(entry.name),
            };
        });

        return {
            cursor: result.list_complete ? undefined : result.cursor,
            keys,
            listComplete: result.list_complete,
        };
    };

    return {
        delete: deleteKey,
        get,
        getRaw,
        getWithMetadata,
        list,
        put,
    };
};

export { assertMetadataWithinLimit, assertOneExpirationForm, validateKey };
