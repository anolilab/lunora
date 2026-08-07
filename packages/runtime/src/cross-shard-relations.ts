/**
 * Cross-shard relation capabilities for reverse cross-backend relations.
 *
 * A `.global()` (D1) parent loading a shard-local child relation can't read the
 * child from D1 — the child's rows live across every shard DO. `@lunora/d1`'s
 * ctx-db therefore accepts injected `crossShardReader` / `crossShardCounter`
 * capabilities and routes the child read/count to them. This module builds those
 * two capabilities so they fan the read out across all shards through the Query
 * Coordinator's RLS-respecting path:
 *
 * POST a `fanOut` envelope to the worker's `/_lunora/rpc` endpoint (the same
 * endpoint the client SDK uses). The worker resolves identity, runs the
 * `authorizeFanOut` gate, and dispatches `__lunora_relation__:read` / `:count`
 * to every live shard for the table — forwarding the caller identity so each
 * shard reads under it (never the admin token). Each shard serves the reserved
 * RPC from its schema-aware ctx-db and returns a BARE value: the child-row array
 * for `:read`, a count for `:count`. The coordinator merges them with `concat`
 * (rows) / `sum` (counts).
 *
 * RLS ACROSS THE HOP: the reserved `__lunora_relation__:*` reader reads the child
 * through the RAW ctx-db, which applies no read policy of its own — so the policy
 * has to arrive as data. `@lunora/d1`'s ctx-db folds the child's `baseWhere` into
 * `where` and projects `relationBaseWhere` into a `relationPolicies` map
 * (`CrossShardReadArgs`) before calling in here; both are forwarded verbatim and
 * re-applied by `serveRelationFanout`. Without them the hop returns every child
 * row for the FK regardless of the caller's row policy — a cross-tenant read.
 *
 * The `x-lunora-userid` / `x-lunora-identity` headers are still forwarded from the
 * per-request context the generated `createShardDO` threads into the `d1`
 * factory, but the public `/_lunora/rpc` re-resolves identity from credentials
 * and ignores them — so they have no effect today (see the per-shard reader).
 *
 * RE-ENTRANCY: the originating global query executes INSIDE a ShardDO; the
 * fan-out loops back through the worker to the child shards. The host shard and
 * the child shards MUST be distinct DO instances — fanning a relation read back
 * into the same DO that is mid-request would re-enter its input gate. This is
 * only a concern for a single-DO topology; a sharded deployment (`.shardBy()`)
 * naturally separates the global-query host from the child shards.
 */

// Type-only: keeps `@lunora/runtime` free of a hard (value) dependency on
// `@lunora/do` while reusing its canonical writer types (see the alias note).
import type { CrossShardReadArgs, DatabaseWriterLike, QueryPage } from "@lunora/shard-engine";

import { encodeIdentityHeader, encodeUserIdHeader } from "../../../shared/identity-header";
import { LunoraError } from "./errors";

/**
 * Reader / counter capabilities, typed against the SAME canonical shard-engine
 * types the `@lunora/d1` ctx-db derives its `crossShardReader` /
 * `crossShardCounter` options from — so the pair drops straight into
 * `createD1CtxDb` with no cast and no structural drift. The reader takes
 * {@link CrossShardReadArgs} (not `QueryArgs`) because the hop is a JSON envelope
 * and the RLS filters must travel as data. The import is type-only:
 * `@lunora/runtime` keeps no hard (value) dependency on `@lunora/do`.
 */
type CrossShardCounter = DatabaseWriterLike["count"];
type CrossShardReader = (table: string, args: CrossShardReadArgs) => Promise<QueryPage>;

interface CrossShardRelationOptions {
    /**
     * `fetch` used for the worker subrequest. Defaults to `globalThis.fetch`.
     * Injectable so the in-DO loopback (or a test) can supply its own.
     */
    fetch?: typeof globalThis.fetch;
    /** Forwarded identity claims (the `x-lunora-identity` envelope), when present. */
    identity?: Record<string, unknown>;

    /**
     * Origin the worker is reachable at (`LUNORA_WORKER_ORIGIN`). The DO issues a
     * loopback subrequest to `${origin}/_lunora/rpc`.
     */
    origin: string;
    /** Forwarded user id (the `x-lunora-userid` header), when authenticated. */
    userId?: string;
}

interface CrossShardRelationCapabilities {
    crossShardCounter: CrossShardCounter;
    crossShardReader: CrossShardReader;
}

const RPC_ENDPOINT = "/_lunora/rpc";

/**
 * Build the `x-lunora-userid` / `x-lunora-identity` headers forwarded on the
 * fan-out so each shard reads under the originating caller's identity. Mirrors
 * the worker's own `resolveForwardContext` header shape.
 */
const buildIdentityHeaders = (options: CrossShardRelationOptions): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (options.userId !== undefined && options.userId.length > 0) {
        // Base64url-encoded when non-Latin-1 (HTTP header values are WebIDL
        // `ByteString`s); see shared/identity-header.ts.
        headers["x-lunora-userid"] = encodeUserIdHeader(options.userId);
    }

    if (options.identity !== undefined) {
        headers["x-lunora-identity"] = encodeIdentityHeader(options.identity);
    }

    return headers;
};

/**
 * POST a `fanOut` envelope to the worker and return the merged `data`. Throws on
 * a non-2xx, AND on a partial fan-out (any shard failed/timed out): the
 * coordinator returns HTTP 200 with the surviving shards merged and the rest in
 * `errors`, but for a relation feeding a parent row a partial `concat`/`sum`
 * reads as silent data loss (dropped children / undercounted `_count`). So a
 * relation read is all-or-nothing — surface the failure rather than hand back a
 * truncated result.
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
        throw new LunoraError(`cross-shard relation ${label} failed: worker returned ${String(response.status)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- workers-types Response.json() is typed `unknown` under tsc (eslint's view sees `any`); the cast is required by `lint:types`
    const result = (await response.json()) as { data?: unknown; failed?: unknown; ok?: unknown };

    if (typeof result.failed === "number" && result.failed > 0) {
        const reached = (typeof result.ok === "number" ? result.ok : 0) + result.failed;

        throw new LunoraError(
            `cross-shard relation ${label} failed on ${String(result.failed)} of ${String(reached)} shard(s) — refusing to return a partial result`,
        );
    }

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
                // Spread rather than re-list the fields: `where` already carries
                // this hop's read policy (folded in by the caller) and
                // `relationPolicies` carries it for the nested `with` hops, so a
                // field silently stopping at this forwarder is an RLS bypass. A
                // hand-written list is exactly how that happens when
                // `CrossShardReadArgs` grows. `JSON.stringify` drops `undefined`,
                // so the wire bytes are identical either way.
                args: { ...args, table },
                fanOut: { merge: { kind: "concat" }, table },
                functionPath: "__lunora_relation__:read",
            },
            "read",
        );

        // eslint-disable-next-line unicorn/no-null -- `continueCursor: null` is @lunora/do's QueryPage "no more pages" sentinel
        return { continueCursor: null, isDone: true, page: Array.isArray(data) ? (data as Record<string, unknown>[]) : [] };
    };

    const crossShardCounter: CrossShardCounter = async (table, where) => {
        const data = await fanOutRelation(
            options,
            {
                args: { table, where },
                fanOut: { merge: { kind: "sum" }, table },
                functionPath: "__lunora_relation__:count",
            },
            "count",
        );

        return typeof data === "number" ? data : 0;
    };

    return { crossShardCounter, crossShardReader };
};

export type { CrossShardCounter, CrossShardReader, CrossShardRelationCapabilities, CrossShardRelationOptions };
export { createCrossShardRelationCapabilities };
