/**
 * Typed server-side RPC into a shard's Durable Object.
 *
 * This is the supported way for a **plain Worker** — one that isn't the generated
 * Lunora worker, but holds the `ShardDO` binding — to call Lunora functions: an
 * app's own MCP server, a webhook handler, a cron worker, an admin route bolted
 * onto an existing Worker.
 *
 * Without it, the only exported primitive is {@link resolveShard}, which returns a
 * raw `{ fetch }` stub. Reaching a function through that stub means hand-rolling
 * Lunora's internal protocol: the `https://shard.internal/rpc` URL, the
 * `{ functionPath, args }` body, the `x-lunora-userid` / `x-lunora-system` identity
 * headers, the `{ result } | { error }` envelope, and the wire codec that carries
 * `bigint` / typed arrays / `NaN`. That is a lot of undocumented surface to
 * reproduce, it is untyped end to end (`functionPath` is a string, the result is
 * `unknown`), and — worst — `x-lunora-system` is a **trust-boundary** header, so
 * getting it wrong is a security bug rather than a broken build.
 *
 * ```ts
 * import { createShardClient } from "@lunora/runtime";
 * import { internal } from "../lunora/_generated/api";
 *
 * // As the signed-in user: RLS and ownership apply exactly as on the client path.
 * const shard = createShardClient(env.SHARD).as({ userId }).forShard(userId);
 * const nodes = await shard.call(internal.mcp.listNodes, { userId });
 * //    ^? typed from the function's args + return validators
 * ```
 *
 * **Privilege.** A client is either *system* (may call `internal*` functions) or
 * end-user*. A fresh client from {@link createShardClient} is system, matching how
 * the runtime dispatches crons and scheduler jobs — a server-side caller holding
 * the DO binding is inside the trust boundary already. `.as({ userId })` attaches a
 * verified identity so the call runs with that user's RLS context; the two compose
 * (`.as(...)` keeps system privilege unless you pass `system: false`), because
 * that's what a trusted server acting *on behalf of* a user needs.
 *
 * **Authorization is yours.** Unlike the generated worker's HTTP path this does not
 * run `authorizeShard`: the caller already chose the shard key. Verify the identity
 * owns the shard before calling — normally the same one-line check the worker's
 * `authorizeShard` does.
 */

import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { DurableObjectJurisdiction, ShardNamespaceLike } from "./resolve-shard";
import { applyJurisdiction, resolveShard } from "./resolve-shard";

/**
 * Structural mirror of `@lunora/client`'s `FunctionReference`, re-declared so this
 * module carries no `runtime → client` (browser SDK) dependency. The phantom
 * marker's shape matches, so a generated `api.*` / `internal.*` reference infers
 * its args and return type through {@link ShardClient.call} unchanged.
 */
interface ShardFunctionReference<Args = unknown, Return = unknown> {
    readonly __lunoraPhantom?: { args: Args; kind: string; returns: Return };
    readonly __lunoraRef: string;
}

/** Args type of a {@link ShardFunctionReference} (`Record&lt;string, unknown>` for an untyped ref). */
type ShardCallArgs<F> = F extends ShardFunctionReference<infer A, infer _R> ? A : Record<string, unknown>;

/** Return type of a {@link ShardFunctionReference} (`unknown` for an untyped ref). */
type ShardCallReturn<F> = F extends ShardFunctionReference<infer _A, infer R> ? R : unknown;

/** A verified end-user identity a shard call runs as. */
interface ShardCallerIdentity {
    /**
     * Full identity claims, forwarded so `ctx.auth.getIdentity()` and any
     * claim-reading RLS policy see the same object the HTTP path would build. Omit
     * to forward only `userId`.
     */
    claims?: Record<string, unknown>;
    /** The verified user id — becomes `ctx.auth.userId` on the shard. */
    userId: string;
}

/** Options for {@link createShardClient}. */
interface ShardClientOptions {
    /** Run every call as this verified end-user identity. See {@link ShardClient.as}. */
    as?: ShardCallerIdentity;
    /** Pin the DO namespace to a data-residency jurisdiction, exactly as the worker does. */
    jurisdiction?: DurableObjectJurisdiction;
    /** Default shard key for calls that don't pass one. See {@link ShardClient.forShard}. */
    shardKey?: string;

    /**
     * Whether calls carry system privilege (may invoke `internalQuery` /
     * `internalMutation` / `internalAction`). Defaults to `true` — a caller holding
     * the DO binding is already inside the trust boundary. Set `false` to make calls
     * behave exactly like an end-user RPC, so an accidental `internal.*` call is
     * rejected by the shard instead of succeeding.
     */
    system?: boolean;
}

/** Per-call overrides. */
interface ShardCallOptions {
    /**
     * Idempotency key. The DO dedupes on `(identity, mutationId)` and replays the
     * cached result, so an at-least-once retry (a queue redelivery, a webhook resend)
     * applies the mutation once. Use a key derived from the upstream event, not a
     * fresh uuid per attempt.
     */
    mutationId?: string;
    /** Override the client's default shard key for this call. */
    shardKey?: string;
}

/** The error half of the shard RPC envelope. */
interface ShardErrorEnvelope {
    error: { code: string; data?: unknown; message: string };
}

/** The success half of the shard RPC envelope. */
interface ShardResultEnvelope {
    commitCursor?: number;
    lastMutationId?: number;
    result?: unknown;
}

/** The shard RPC response envelope, mirroring what the DO returns. */
type ShardResponseBody = ShardErrorEnvelope | ShardResultEnvelope;

/** A typed caller bound to a namespace + privilege + (optionally) a shard. */
interface ShardClient {
    /** Derive a client that runs as `identity`. Keeps system privilege unless `system: false` was set. */
    as: (identity: ShardCallerIdentity) => ShardClient;
    /** Derive a client with no end-user identity — a pure system caller. */
    asSystem: () => ShardClient;

    /**
     * Call a Lunora function on the shard. Pass a generated reference
     * (`internal.mcp.listNodes`) for typed args and return; a bare
     * `"namespace:fn"` string works as the escape hatch and returns `unknown`.
     *
     * Throws a {@link LunoraError} carrying the server's `code` when the function
     * fails — the same error shape the browser client surfaces, so a caller branches
     * on `FORBIDDEN` / `CONFLICT` / … identically on both sides.
     */
    call: <F extends ShardFunctionReference | string>(
        reference: F,
        args: F extends string ? Record<string, unknown> : ShardCallArgs<F>,
        options?: ShardCallOptions,
    ) => Promise<ShardCallReturn<F>>;

    /** Derive a client whose calls default to `shardKey`. */
    forShard: (shardKey: string) => ShardClient;
}

/** Resolve the function path from a reference or a raw string. */
const referencePath = (reference: unknown): string => {
    if (typeof reference === "string") {
        return reference;
    }

    const path = (reference as { __lunoraRef?: unknown } | undefined)?.__lunoraRef;

    if (typeof path !== "string" || path.length === 0) {
        throw new LunoraError("INTERNAL", "createShardClient: expected a generated function reference (api.*/internal.*) or a 'namespace:fn' string");
    }

    return path;
};

/**
 * Rebuild the thrown error from the shard's `{ error }` envelope, preserving the
 * machine-readable `code` and any wire-encoded `data`, so a server-side caller can
 * branch on the verdict exactly like a browser caller.
 */
const reconstructShardError = (error: { code: string; data?: unknown; message: string }): LunoraError => {
    const rebuilt = new LunoraError(error.code, error.message);

    if (error.data !== undefined) {
        (rebuilt as LunoraError & { data?: unknown }).data = decodeWire(error.data);
    }

    return rebuilt;
};

/**
 * Create a typed server-side caller over a `ShardDO` namespace binding.
 *
 * See the module docs for the privilege model and the authorization caveat.
 */
const createShardClient = (namespace: ShardNamespaceLike, options: ShardClientOptions = {}): ShardClient => {
    const resolvedNamespace = applyJurisdiction(namespace, options.jurisdiction);
    const system = options.system ?? true;

    const derive = (overrides: Partial<ShardClientOptions>): ShardClient => createShardClient(namespace, { ...options, ...overrides });

    return {
        as: (identity) => derive({ as: identity }),
        asSystem: () => derive({ as: undefined }),

        call: async (reference, args, callOptions) => {
            const functionPath = referencePath(reference);
            const shardKey = callOptions?.shardKey ?? options.shardKey;

            if (shardKey === undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    `createShardClient: no shard key for "${functionPath}" — pass one to createShardClient({ shardKey }), .forShard(key), or the call's options`,
                );
            }

            const headers: Record<string, string> = { "content-type": "application/json" };

            // Marks the call as a trusted server-initiated dispatch, which is what
            // lets it reach `internal*` functions. The Worker edge strips a forged
            // copy off inbound client requests, so this header only ever means
            // anything on a call originating inside the trust boundary — like this one.
            if (system) {
                headers["x-lunora-system"] = "1";
            }

            // System privilege and an end-user identity coexist: the shard rebuilds
            // `ctx.auth` from these headers independently of the system flag, so the
            // call can be trusted AND carry the user's RLS/ownership context.
            if (options.as) {
                headers["x-lunora-userid"] = options.as.userId;

                if (options.as.claims) {
                    headers["x-lunora-identity"] = JSON.stringify(options.as.claims);
                }
            }

            if (callOptions?.mutationId !== undefined && callOptions.mutationId.length > 0) {
                headers["x-lunora-mutation-id"] = callOptions.mutationId;
            }

            const response = await resolveShard(resolvedNamespace, shardKey).fetch(
                new Request("https://shard.internal/rpc", {
                    // Encode so exotic leaves (`bigint`, typed arrays, `NaN`) survive
                    // the hop. A pure-JSON `args` encodes byte-identically.
                    body: JSON.stringify({ args: encodeWire(args ?? {}), functionPath }),
                    headers,
                    method: "POST",
                }),
            );

            let body: ShardResponseBody;

            try {
                body = await response.json();
            } catch {
                const statusText = response.statusText ? ` ${response.statusText}` : "";

                throw new LunoraError(
                    "INTERNAL",
                    `createShardClient: shard response for "${functionPath}" was not JSON (status ${String(response.status)}${statusText})`,
                );
            }

            if ("error" in body) {
                throw reconstructShardError(body.error);
            }

            // A non-2xx whose body parsed as JSON but carried no `error` envelope
            // would otherwise read as a successful `undefined` result.
            if (!response.ok) {
                const statusText = response.statusText ? ` ${response.statusText}` : "";

                throw new LunoraError("INTERNAL", `createShardClient: shard call "${functionPath}" failed (status ${String(response.status)}${statusText})`);
            }

            return decodeWire(body.result) as never;
        },

        forShard: (shardKey) => derive({ shardKey }),
    };
};

export type { ShardCallArgs, ShardCallerIdentity, ShardCallOptions, ShardCallReturn, ShardClient, ShardClientOptions, ShardFunctionReference };
export { createShardClient };
