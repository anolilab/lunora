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
    putValue: (options: { expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }) => Promise<void>;
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
        const ns = namespaces[binding];

        if (ns === undefined) {
            throw new Error(`@lunora/bindings/kv: no namespace registered under binding "${binding}"`);
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
        const result = await ns.getWithMetadata(getOptions.key, "text");

        // eslint-disable-next-line unicorn/no-null -- mirrors KV API: null when absent
        return { metadata: result.metadata ?? null, value: (result.value as string | null) ?? null };
    };

    const putValue = async (putOptions: { expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }): Promise<void> => {
        const ns = resolveNamespace(putOptions.namespace);

        await ns.put(putOptions.key, putOptions.value, {
            expirationTtl: putOptions.expirationTtl,
            metadata: putOptions.metadata,
        });
    };

    const deleteKey = async (deleteOptions: { key: string; namespace: string }): Promise<void> => {
        const ns = resolveNamespace(deleteOptions.namespace);

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

export { createKvIntrospector };
export type { CreateKvIntrospectorOptions, KvIntrospectorLike };
