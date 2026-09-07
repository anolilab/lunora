/**
 * Factory for a `KvIntrospector`-compatible object backed by one or more bound
 * `KVNamespaceLike` instances. Pass the returned value as `kvIntrospector` on
 * `WorkerOptions` to enable the studio's `/_lunora/admin/kv/*` endpoints.
 *
 * The return type is declared inline (not imported from `@lunora/runtime`) so
 * this module adds no dependency edge between `@lunora/bindings` and the
 * runtime package; the object satisfies the `KvIntrospector` contract
 * structurally at the call site.
 */
import { LunoraError } from "@lunora/errors";

import { assertMetadataWithinLimit, assertOneExpirationForm, validateKey } from "./create-kv";
import type { KVNamespaceLike } from "./types";

/** One KV namespace as the studio's KV browser surfaces it (mirrors the runtime's KvNamespaceSummary). */
interface KvNamespaceSummaryLike {
    binding: string;
}

/** One key entry as surfaced by the KV admin browser (mirrors the runtime's KvKeyEntry). */
interface KvKeyEntryLike {
    expiration?: number;
    metadata?: unknown;
    name: string;
}

/** A paginated page of KV keys (mirrors the runtime's KvKeyListResult). */
interface KvKeyListResultLike {
    cursor?: string;
    keys: KvKeyEntryLike[];
    listComplete: boolean;
}

/** A value together with its metadata (mirrors the runtime's KvValueResult). */
interface KvValueResultLike {
    metadata: unknown;
    value: null | string;
}

/**
 * The structural shape of a KV introspector — mirrors `KvIntrospector` from
 * `@lunora/runtime` without importing it, keeping the dependency graph clean.
 */
interface KvIntrospectorLike {
    deleteKey: (options: { key: string; namespace: string }) => Promise<void>;
    getValue: (options: { key: string; namespace: string }) => Promise<KvValueResultLike>;
    listKeys: (options: { cursor?: string; limit?: number; namespace: string; prefix?: string }) => Promise<KvKeyListResultLike>;
    listNamespaces: () => Promise<KvNamespaceSummaryLike[]>;
    putValue: (options: { expiration?: number; expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }) => Promise<void>;
}

/** Construction options for {@link createKvIntrospector}. */
interface CreateKvIntrospectorOptions {
    /**
     * Map of binding name → bound KV namespace. Each entry becomes one
     * namespace the studio can browse. Example:
     * ```ts
     * createKvIntrospector({ namespaces: { MY_KV: env.MY_KV } })
     * ```
     */
    namespaces: Record<string, KVNamespaceLike>;
}

/**
 * Build a `KvIntrospector`-compatible object from a map of bound KV namespaces.
 * Pass the result as `kvIntrospector` on `WorkerOptions` to enable the studio's
 * KV browser (`/_lunora/admin/kv/*` endpoints).
 * @example
 * ```ts
 * createWorker({
 *   // …
 *   kvIntrospector: createKvIntrospector({ namespaces: { MY_KV: env.MY_KV } }),
 * });
 * ```
 */
const createKvIntrospector = (options: CreateKvIntrospectorOptions): KvIntrospectorLike => {
    const { namespaces } = options;

    /** Resolve a namespace by binding name, throwing a descriptive error when absent. */
    const resolveNamespace = (binding: string): KVNamespaceLike => {
        // Own-property check, not `=== undefined`: a prototype key
        // ("__proto__", "constructor", …) resolves to an inherited
        // Object.prototype member on this plain object and would bypass the
        // not-found guard. Object.hasOwn routes such names to the controlled
        // LunoraError instead of returning a non-namespace value.
        const ns = namespaces[binding];

        if (!Object.hasOwn(namespaces, binding) || ns === undefined) {
            throw new LunoraError("BAD_REQUEST", `@lunora/bindings/kv: no namespace registered under binding "${binding}"`);
        }

        return ns;
    };

    // No `await` needed — the binding map is already in memory — so this returns
    // a resolved promise directly rather than being an (await-less) async fn.
    const listNamespaces = (): Promise<KvNamespaceSummaryLike[]> =>
        Promise.resolve(
            Object.keys(namespaces).map((binding) => {
                return { binding };
            }),
        );

    const listKeys = async (listOptions: { cursor?: string; limit?: number; namespace: string; prefix?: string }): Promise<KvKeyListResultLike> => {
        const ns = resolveNamespace(listOptions.namespace);
        const result = await ns.list({ cursor: listOptions.cursor, limit: listOptions.limit, prefix: listOptions.prefix });

        const keys: KvKeyEntryLike[] = result.keys.map((entry) => {
            return {
                expiration: entry.expiration,
                metadata: entry.metadata,
                name: entry.name,
            };
        });

        return {
            cursor: result.list_complete ? undefined : result.cursor,
            keys,
            listComplete: result.list_complete,
        };
    };

    const getValue = async (getOptions: { key: string; namespace: string }): Promise<KvValueResultLike> => {
        const ns = resolveNamespace(getOptions.namespace);

        validateKey(getOptions.key);

        const result = await ns.getWithMetadata(getOptions.key, "text");

        // eslint-disable-next-line unicorn/no-null -- mirrors KV API: null when absent
        return { metadata: result.metadata ?? null, value: (result.value as string | null) ?? null };
    };

    const putValue = async (putOptions: {
        expiration?: number;
        expirationTtl?: number;
        key: string;
        metadata?: unknown;
        namespace: string;
        value: string;
    }): Promise<void> => {
        const ns = resolveNamespace(putOptions.namespace);

        // `expiration` (absolute) lets the studio round-trip a key's existing TTL
        // on edit so saving a value doesn't silently make an expiring key permanent.
        // It cannot be combined with `expirationTtl`, which KV would silently
        // prefer — same rule `createKv` enforces, same helper.
        assertOneExpirationForm(putOptions);

        // The studio's KV browser builds `key` and `metadata` from free-text
        // boxes, so the key rules and the 1,024-byte metadata ceiling `createKv`
        // applies must apply here too — otherwise an over-long key or an
        // oversized metadata object reaches `ns.put` and comes back as whatever
        // opaque error the binding raises, naming no limit.
        validateKey(putOptions.key);

        if (putOptions.metadata !== undefined) {
            assertMetadataWithinLimit(putOptions.metadata);
        }

        await ns.put(putOptions.key, putOptions.value, {
            expiration: putOptions.expiration,
            expirationTtl: putOptions.expirationTtl,
            metadata: putOptions.metadata,
        });
    };

    const deleteKey = async (deleteOptions: { key: string; namespace: string }): Promise<void> => {
        const ns = resolveNamespace(deleteOptions.namespace);

        validateKey(deleteOptions.key);

        await ns.delete(deleteOptions.key);
    };

    return {
        deleteKey,
        getValue,
        listKeys,
        listNamespaces,
        putValue,
    };
};

/**
 * Duck-type guard: `true` when `value` exposes the Workers KV namespace surface
 * the studio browser drives (`getWithMetadata` + `list` + `put` + `delete`). This
 * set uniquely identifies a `KVNamespace` among the other Cloudflare bindings on
 * `env` — R2 buckets have no `getWithMetadata`, Durable Object namespaces / queues
 * / service bindings have none of `list`+`put`+`delete` together.
 */
const isKvNamespace = (value: unknown): value is KVNamespaceLike => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return (
        typeof candidate.getWithMetadata === "function" &&
        typeof candidate.list === "function" &&
        typeof candidate.put === "function" &&
        typeof candidate.delete === "function"
    );
};

/**
 * Zero-config KV introspector: scan a worker `env` for every bound Workers KV
 * namespace and register each under its binding name. Every `kv_namespaces` entry
 * in `wrangler.jsonc` then appears in the studio's KV browser automatically — no
 * hand-written `createKvIntrospector({ namespaces: … })` call, and any binding
 * name (not just `KV`) and any number of namespaces light up. Non-KV bindings
 * (R2, Durable Objects, queues, secrets, …) are skipped via {@link isKvNamespace}.
 *
 * Returns an introspector even when `env` holds no KV namespaces — its
 * `listNamespaces()` resolves to `[]`, so the studio renders an empty state
 * rather than a "not configured" error.
 * @example
 * ```ts
 * createWorker({
 *   // …
 *   kvIntrospector: createKvIntrospectorFromEnv(env),
 * });
 * ```
 */
const createKvIntrospectorFromEnv = (env: unknown): KvIntrospectorLike => {
    const namespaces: Record<string, KVNamespaceLike> = {};

    if (typeof env === "object" && env !== null) {
        for (const [binding, value] of Object.entries(env)) {
            if (isKvNamespace(value)) {
                namespaces[binding] = value;
            }
        }
    }

    return createKvIntrospector({ namespaces });
};

export { createKvIntrospector, createKvIntrospectorFromEnv };
export type { CreateKvIntrospectorOptions, KvIntrospectorLike };
