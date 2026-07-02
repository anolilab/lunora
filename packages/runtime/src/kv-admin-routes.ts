/**
 * The `/_lunora/admin/kv/*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./vector-admin-routes`). Backs the studio's KV namespace browser:
 * list namespaces, browse keys with prefix filtering and cursor pagination,
 * read/write/delete individual values with metadata. All routes reach the admin
 * gate + the injected `kvIntrospector` through {@link KvAdminRouteDeps}, so
 * this module imports no runtime values from `create-worker`.
 */
import { LunoraError } from "./errors";

const KV_NAMESPACES_PATH = "/_lunora/admin/kv/namespaces";
const KV_KEYS_PATH = "/_lunora/admin/kv/keys";
const KV_VALUE_PATH = "/_lunora/admin/kv/value";

/** One KV namespace as the studio's KV browser surfaces it. */
interface KvNamespaceSummary {
    /** The wrangler/env binding name, e.g. `"MY_KV"`. */
    binding: string;
}

/** One key entry as the KV admin browser surfaces it. */
interface KvKeyEntry {
    /** Absolute expiration (Unix seconds), when set. */
    expiration?: number;
    /** Per-key metadata set at write time, or absent when none. */
    metadata?: unknown;
    /** The key name. */
    name: string;
}

/** A paginated page of KV keys as the admin browser returns it. */
interface KvKeyListResult {
    /** Opaque cursor for the next page; absent when the listing is complete. */
    cursor?: string;
    /** The keys on this page. */
    keys: KvKeyEntry[];
    /** True when this is the final page. */
    listComplete: boolean;
}

/** A KV value together with its stored metadata. */
interface KvValueResult {
    /** Per-key metadata, or `null` when none. */
    metadata: unknown;
    /** The stored value as a string, or `null` when the key is absent. */
    value: null | string;
}

/**
 * The introspector the worker wires for the studio's KV browser. Build it from
 * the env's bound KV namespaces. Omit it and the `/_lunora/admin/kv/*`
 * endpoints respond `KV_NOT_CONFIGURED`.
 */
interface KvIntrospector {
    /** Delete a key from a namespace. No-op when the key is absent. */
    deleteKey: (options: { key: string; namespace: string }) => Promise<void>;
    /** Read a value (as text) and its metadata from a namespace key. */
    getValue: (options: { key: string; namespace: string }) => Promise<KvValueResult>;
    /** List keys in a namespace, optionally filtered by prefix and paginated. */
    listKeys: (options: { cursor?: string; limit?: number; namespace: string; prefix?: string }) => Promise<KvKeyListResult>;
    /** List the registered KV namespaces (binding names). */
    listNamespaces: () => Promise<KvNamespaceSummary[]>;
    /** Write a value (as text) with optional TTL and metadata. */
    putValue: (options: { expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }) => Promise<void>;
}

/** The worker internals the KV routes reach through injection rather than closure. */
interface KvAdminRouteDeps {
    /** The KV introspector off `WorkerOptions`. */
    kvIntrospector?: KvIntrospector;
    /** Read + parse the JSON request body under the runtime's size limit. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
    /** Admin-gate + require a configured option, else throw the `*_NOT_CONFIGURED` error. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
}

/** Build the `/_lunora/admin/kv/*` route map merged into the worker's internal route table. */
const buildKvAdminRoutes = (deps: KvAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const { readJsonBody, requireAdminOption } = deps;

    /** Admin-gate the request and return the configured introspector (or throw `KV_NOT_CONFIGURED`). */
    const gate = (request: Request): KvIntrospector =>
        requireAdminOption(request, deps.kvIntrospector, {
            code: "KV_NOT_CONFIGURED",
            message: "KV endpoints require a `kvIntrospector` on the worker",
        });

    /** A 200 JSON response with the standard content-type header. */
    const ok = (payload: unknown): Response => Response.json(payload, { headers: { "content-type": "application/json" }, status: 200 });

    /** Read + validate the `namespace` and `key` query params shared by the value GET/DELETE handlers. */
    const requireNamespaceAndKey = (request: Request, verb: string): { key: string; namespace: string } => {
        const url = new URL(request.url);
        const namespace = url.searchParams.get("namespace") ?? "";
        const key = url.searchParams.get("key") ?? "";

        if (namespace === "") {
            throw new LunoraError(`KV-value ${verb} request requires a \`namespace\` query parameter`, { code: "BAD_REQUEST", status: 400 });
        }

        if (key === "") {
            throw new LunoraError(`KV-value ${verb} request requires a \`key\` query parameter`, { code: "BAD_REQUEST", status: 400 });
        }

        return { key, namespace };
    };

    const handleKvNamespaces = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new LunoraError("KV-namespaces endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        return ok({ namespaces: await gate(request).listNamespaces() });
    };

    const handleKvKeys = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new LunoraError("KV-keys endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const introspector = gate(request);
        const url = new URL(request.url);
        const namespace = url.searchParams.get("namespace") ?? "";

        if (namespace === "") {
            throw new LunoraError("KV-keys request requires a `namespace` query parameter", { code: "BAD_REQUEST", status: 400 });
        }

        const prefix = url.searchParams.get("prefix") ?? undefined;
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);

        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            throw new LunoraError("KV-keys `limit` must be a positive integer", { code: "BAD_REQUEST", status: 400 });
        }

        return ok(await introspector.listKeys({ cursor, limit, namespace, prefix }));
    };

    const handleKvValueGet = async (request: Request): Promise<Response> => {
        const introspector = gate(request);

        return ok(await introspector.getValue(requireNamespaceAndKey(request, "GET")));
    };

    const handleKvValuePut = async (request: Request): Promise<Response> => {
        const introspector = gate(request);
        const candidate = (await readJsonBody(request)) as { expirationTtl?: unknown; key?: unknown; metadata?: unknown; namespace?: unknown; value?: unknown };

        if (typeof candidate.namespace !== "string" || candidate.namespace === "") {
            throw new LunoraError("KV-value PUT request requires a `namespace` string", { code: "BAD_REQUEST", status: 400 });
        }

        if (typeof candidate.key !== "string" || candidate.key === "") {
            throw new LunoraError("KV-value PUT request requires a `key` string", { code: "BAD_REQUEST", status: 400 });
        }

        if (typeof candidate.value !== "string") {
            throw new LunoraError("KV-value PUT request requires a `value` string", { code: "BAD_REQUEST", status: 400 });
        }

        if (
            candidate.expirationTtl !== undefined &&
            (typeof candidate.expirationTtl !== "number" || !Number.isInteger(candidate.expirationTtl) || candidate.expirationTtl < 60)
        ) {
            throw new LunoraError("KV-value PUT `expirationTtl` must be an integer ≥ 60", { code: "BAD_REQUEST", status: 400 });
        }

        await introspector.putValue({
            expirationTtl: candidate.expirationTtl,
            key: candidate.key,
            metadata: candidate.metadata,
            namespace: candidate.namespace,
            value: candidate.value,
        });

        return ok({ ok: true });
    };

    const handleKvValueDelete = async (request: Request): Promise<Response> => {
        const introspector = gate(request);

        await introspector.deleteKey(requireNamespaceAndKey(request, "DELETE"));

        return ok({ deleted: true });
    };

    // `/kv/value` is method-multiplexed: GET reads, PUT writes, DELETE removes.
    const kvValueHandlers: Record<string, (request: Request) => Promise<Response>> = {
        DELETE: handleKvValueDelete,
        GET: handleKvValueGet,
        PUT: handleKvValuePut,
    };

    const handleKvValue = (request: Request): Promise<Response> => {
        const handler = kvValueHandlers[request.method];

        if (!handler) {
            throw new LunoraError("KV-value endpoint requires GET, PUT, or DELETE", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        return handler(request);
    };

    return {
        [KV_NAMESPACES_PATH]: handleKvNamespaces,
        [KV_KEYS_PATH]: handleKvKeys,
        [KV_VALUE_PATH]: handleKvValue,
    };
};

export type { KvAdminRouteDeps, KvIntrospector, KvKeyEntry, KvKeyListResult, KvNamespaceSummary, KvValueResult };
export { buildKvAdminRoutes, KV_KEYS_PATH, KV_NAMESPACES_PATH, KV_VALUE_PATH };
