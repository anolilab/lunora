/**
 * Cross-shard relation capabilities for reverse cross-backend relations.
 *
 * A `.global()` (D1) parent loading a shard-local child relation can't read the
 * child from D1 — the child's rows live across every shard DO. `@cirrus/d1`'s
 * ctx-db therefore accepts injected `crossShardReader` / `crossShardCounter`
 * capabilities and routes the child read/count to them. This module builds those
 * two capabilities so they fan the read out across all shards through the Query
 * Coordinator's RLS-respecting path:
 *
 * POST a `fanOut` envelope to the worker's `/_cirrus/rpc` endpoint (the same
 * endpoint the client SDK uses). The worker resolves identity, runs the
 * `authorizeFanOut` gate, and dispatches `__cirrus_relation__:read` / `:count`
 * to every live shard for the table — forwarding the caller identity so each
 * shard reads under it (never the admin token). Each shard serves the reserved
 * RPC from its schema-aware ctx-db and returns a BARE value: the child-row array
 * for `:read`, a count for `:count`. The coordinator merges them with `concat`
 * (rows) / `sum` (counts).
 *
 * The identity headers are taken from the per-request context the generated
 * `createShardDO` threads into the `d1` factory, so the fan-out can run as the
 * same user the originating global query runs as. Whether those headers reach
 * each shard depends on the worker endpoint: a deployment whose `resolveIdentity`
 * honours the forwarded `x-cirrus-userid` (an internal-trust endpoint) propagates
 * the caller; the public `/_cirrus/rpc`, which re-resolves identity from
 * credentials, does not. This is currently forward-looking: the reserved
 * `__cirrus_relation__:*` reader reads the child through the raw ctx-db (no read
 * policy applied — matching same-backend relation reads, which also bypass RLS),
 * so the rows it returns are identity-independent today.
 *
 * RE-ENTRANCY: the originating global query executes INSIDE a ShardDO; the
 * fan-out loops back through the worker to the child shards. The host shard and
 * the child shards MUST be distinct DO instances — fanning a relation read back
 * into the same DO that is mid-request would re-enter its input gate. This is
 * only a concern for a single-DO topology; a sharded deployment (`.shardBy()`)
 * naturally separates the global-query host from the child shards.
 */

/** A page of child rows, structurally matching `@cirrus/d1`'s `findMany` return. */
interface CrossShardQueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

/** Per-relation read arguments forwarded from `resolveWith` (the FK filter + nested shape). */
interface CrossShardReaderArgs {
    orderBy?: unknown;
    where?: Record<string, unknown>;
    with?: Record<string, unknown>;
}

/** Reader capability: structurally `@cirrus/d1`'s `DatabaseWriterLike["findMany"]`. */
type CrossShardReader = (table: string, args?: CrossShardReaderArgs) => Promise<CrossShardQueryPage>;

/** Counter capability: structurally `@cirrus/d1`'s `DatabaseWriterLike["count"]`. */
type CrossShardCounter = (table: string, where?: Record<string, unknown>) => Promise<number>;

interface CrossShardRelationOptions {
    /**
     * `fetch` used for the worker subrequest. Defaults to `globalThis.fetch`.
     * Injectable so the in-DO loopback (or a test) can supply its own.
     */
    fetch?: typeof globalThis.fetch;
    /** Forwarded identity claims (the `x-cirrus-identity` envelope), when present. */
    identity?: Record<string, unknown>;

    /**
     * Origin the worker is reachable at (`CIRRUS_WORKER_ORIGIN`). The DO issues a
     * loopback subrequest to `${origin}/_cirrus/rpc`.
     */
    origin: string;
    /** Forwarded user id (the `x-cirrus-userid` header), when authenticated. */
    userId?: string;
}

interface CrossShardRelationCapabilities {
    crossShardCounter: CrossShardCounter;
    crossShardReader: CrossShardReader;
}

const RPC_ENDPOINT = "/_cirrus/rpc";

/**
 * Build the `x-cirrus-userid` / `x-cirrus-identity` headers forwarded on the
 * fan-out so each shard reads under the originating caller's identity. Mirrors
 * the worker's own `resolveForwardContext` header shape.
 */
const buildIdentityHeaders = (options: CrossShardRelationOptions): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (options.userId !== undefined && options.userId.length > 0) {
        headers["x-cirrus-userid"] = options.userId;
    }

    if (options.identity !== undefined) {
        headers["x-cirrus-identity"] = JSON.stringify(options.identity);
    }

    return headers;
};

/**
 * POST a `fanOut` envelope to the worker and return the merged `data`. Throws a
 * descriptive error on a non-2xx so the failure surfaces as the relation read's
 * error rather than silently dropping rows.
 */
const fanOutRelation = async (options: CrossShardRelationOptions, body: Record<string, unknown>, label: string): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(
        new Request(`${options.origin}${RPC_ENDPOINT}`, {
            body: JSON.stringify(body),
            headers: buildIdentityHeaders(options),
            method: "POST",
        }),
    );

    if (!response.ok) {
        throw new Error(`cross-shard relation ${label} failed: worker returned ${String(response.status)}`);
    }

    const result = await response.json();

    return result.data;
};

/**
 * Build the `crossShardReader` / `crossShardCounter` pair for a single request,
 * wired to fan reverse-relation reads out across every shard via the worker's
 * coordinator. Pass the result straight into `createD1CtxDb`.
 */
const createCrossShardRelationCapabilities = (options: CrossShardRelationOptions): CrossShardRelationCapabilities => {
    const crossShardReader: CrossShardReader = async (table, args) => {
        const data = await fanOutRelation(
            options,
            {
                args: { orderBy: args?.orderBy, table, where: args?.where, with: args?.with },
                fanOut: { merge: { kind: "concat" }, table },
                functionPath: "__cirrus_relation__:read",
            },
            "read",
        );

        // eslint-disable-next-line unicorn/no-null -- `continueCursor: null` mirrors @cirrus/d1's QueryPage shape (the "no more pages" sentinel)
        return { continueCursor: null, isDone: true, page: Array.isArray(data) ? (data as Record<string, unknown>[]) : [] };
    };

    const crossShardCounter: CrossShardCounter = async (table, where) => {
        const data = await fanOutRelation(
            options,
            {
                args: { table, where },
                fanOut: { merge: { kind: "sum" }, table },
                functionPath: "__cirrus_relation__:count",
            },
            "count",
        );

        return typeof data === "number" ? data : 0;
    };

    return { crossShardCounter, crossShardReader };
};

export type { CrossShardCounter, CrossShardQueryPage, CrossShardReader, CrossShardReaderArgs, CrossShardRelationCapabilities, CrossShardRelationOptions };
export { createCrossShardRelationCapabilities };
