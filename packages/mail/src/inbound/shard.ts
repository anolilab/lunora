/**
 * Structural projections of the `SHARD` Durable Object namespace + one shard
 * stub, shared by the inbound dispatcher. Mirrors the shapes the outbound dev
 * capture sink uses (`packages/mail/src/from-env.ts`) so inbound dispatch routes
 * a parsed message into a Lunora function over the exact same admin-RPC-over-shard
 * path — without importing any Cloudflare types into `@lunora/mail`.
 */
import { LunoraError } from "@lunora/errors";

import { encodeWire } from "../../../../shared/wire-codec";

/** Default shard the runtime routes admin RPC (captured mail, inbound dispatch) through. */
const DEFAULT_ROOT_SHARD = "__root__";

/** Structural projection of one shard stub — only `fetch` returning a Fetch-`Response`-like object. */
interface ShardStubLike {
    fetch: (
        input: string,
        init?: { body?: string; headers?: Record<string, string>; method?: string },
    ) => Promise<{ json: () => Promise<unknown>; ok?: boolean; status?: number }>;
}

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/** Structural projection of the `SHARD` Durable Object namespace. */
interface ShardNamespaceLike {
    get: (id: unknown) => ShardStubLike;
    idFromName: (name: string) => unknown;

    /**
     * Derive a jurisdiction-restricted subnamespace. Optional because older
     * workers-types releases (and test doubles) may not expose it.
     */
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ShardNamespaceLike;
}

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured. Fail-closed when the binding
 * lacks `.jurisdiction()` so a residency constraint is never silently dropped.
 */
const applyJurisdiction = (namespace: ShardNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ShardNamespaceLike => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/mail: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

/** Options for {@link postShardRpc}. */
interface PostShardRpcOptions {
    /** Admin bearer authorizing the shard RPC. */
    adminToken: string;
    /** The JSON-serialisable RPC envelope (`{ args, functionPath, shardKey? }`). */
    envelope: unknown;
    /** Optional data-residency jurisdiction the shard is pinned to. */
    jurisdiction?: DurableObjectJurisdiction;
    /** Diagnostic prefix for failure errors (e.g. the caller + target function). */
    label: string;
    /** Shard the RPC targets. */
    shardKey: string;
}

/**
 * POST an RPC envelope to a shard stub over the shared admin-RPC-over-shard path
 * — the single owner of the `https://shard.internal/rpc` URL, the admin bearer
 * headers, the `response.ok` check, and the `{ error }` envelope check. Both the
 * inbound dispatcher (`handler.ts`) and the outbound dev capture sink
 * (`from-env.ts`) call through here so the two paths cannot drift.
 *
 * Throws a {@link LunoraError} on a non-2xx response or an error envelope
 * (labelled with `options.label`); returns the parsed JSON body otherwise.
 */
const postShardRpc = async (namespace: ShardNamespaceLike, options: PostShardRpcOptions): Promise<unknown> => {
    const scoped = applyJurisdiction(namespace, options.jurisdiction);
    const stub = scoped.get(scoped.idFromName(options.shardKey));
    const response = await stub.fetch("https://shard.internal/rpc", {
        // The envelope is a WIRE payload, and the shard decodes it on BOTH arms
        // this route reaches: an ordinary function dispatch runs
        // `decodeWire(payload.args)`, and a reserved `__lunora_admin__:*` op runs
        // `decodeAdminArgs`. Un-encoded, the hop was asymmetric — a `bigint` threw
        // in `JSON.stringify` before anything was sent, and a `Date` arrived as an
        // ISO string. Encoding here rather than at the two callers keeps this
        // function the single owner of what goes on the wire, as it already is of
        // the URL, the headers and the response checks.
        //
        // Identity for pure JSON, so neither existing caller changes: the capture
        // sink's `SendPayload` is strings throughout, and the inbound dispatcher's
        // default `resolveArgs` (`toJsonSafeEmail`) has already base64'd the only
        // binary it carries. It is a caller-supplied `resolveArgs` override that
        // was exposed.
        body: JSON.stringify(encodeWire(options.envelope)),
        headers: {
            authorization: `Bearer ${options.adminToken}`,
            "content-type": "application/json",
            // Marks the dispatch trusted server-initiated, exactly as the runtime's
            // scheduler/cron path does. The shard's `/rpc` never inspects the bearer
            // for a user function, so without this header the call is shaped like an
            // anonymous browser RPC: an `internalAction`/`internalMutation` target
            // answers FUNCTION_NOT_FOUND. Both callers here run inside the Worker's
            // trust boundary and already hold the admin token; the header is never
            // copied off an inbound request (the runtime strips a client-sent copy).
            "x-lunora-system": "1",
        },
        method: "POST",
    });

    // A shard stub returns a Fetch `Response`; treat a non-2xx as a failure.
    if (response.ok === false) {
        throw new LunoraError("INTERNAL", `${options.label} failed (HTTP ${String(response.status ?? "?")}).`);
    }

    const body: unknown = await response.json();

    // …and an `{ error }` envelope in a 2xx body as a failure too.
    if (typeof body === "object" && body !== null && "error" in body) {
        const { error } = body as { error?: unknown };

        if (error !== undefined && error !== null) {
            throw new LunoraError("INTERNAL", `${options.label} returned an error: ${JSON.stringify(error)}`);
        }
    }

    return body;
};

export { applyJurisdiction, DEFAULT_ROOT_SHARD, postShardRpc };
export type { DurableObjectJurisdiction, PostShardRpcOptions, ShardNamespaceLike, ShardStubLike };
