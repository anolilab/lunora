/**
 * `createInboundEmailHandler()` — the inbound counterpart to the outbound
 * `cloudflareSend` callback-injection pattern (`cloudflare-transport.ts`).
 *
 * Cloudflare delivers inbound mail to a Worker's exported `email(message, env,
 * ctx)` handler, where `message` is a `ForwardableEmailMessage`. This factory
 * returns exactly that callback, typed against a **structural**
 * `ForwardableEmailMessageLike` so `@cirrus/mail` needs no `cloudflare:email`
 * import — the host's generated entry supplies the real binding. The handler
 * reads `message.raw`, parses it, and dispatches the normalised message into a
 * Cirrus mutation/action via a caller-supplied `dispatch`.
 *
 * `dispatchToCirrusFunction` is the batteries-included `dispatch`: it posts an
 * `RpcEnvelope` to the root shard stub over the same admin-RPC-over-shard path
 * the dev capture sink uses (`from-env.ts`).
 */
import type { InboundEmail, RawInboundEmail } from "./parse";
import type { ShardNamespaceLike } from "./shard";

/**
 * Structural projection of Cloudflare's `ForwardableEmailMessage` (verified
 * against `@cloudflare/workers-types`' `ForwardableEmailMessage`). Only the
 * members the handler touches are modelled, so the host can pass the real
 * runtime object without `@cirrus/mail` importing `cloudflare:email`.
 */
interface ForwardableEmailMessageLike {
    /** Forward this message to a verified destination address. */
    forward: (rcptTo: string, headers?: Headers) => Promise<unknown>;
    /** Envelope `From`. */
    readonly from: string;
    /** Parsed top-level headers. */
    readonly headers: Headers;
    /** Stream of the raw RFC 822 message content. */
    readonly raw: ReadableStream<Uint8Array>;
    /** Reply to the sender with a new message. */
    reply: (message: { from: string; raw: string; to: string }) => Promise<unknown>;
    /** Reject the message with a permanent SMTP error (Cloudflare bounces/retries). */
    setReject: (reason: string) => void;
    /** Envelope `To`. */
    readonly to: string;
}

/** Context threaded to a `dispatch` callback alongside the parsed message. */
interface InboundDispatchContext<TEnv = Record<string, unknown>> {
    /** Cloudflare's `ExecutionContext`, forwarded verbatim from the `email()` entry. */
    ctx: unknown;
    /** Worker `env` (bindings, vars, secrets) projected as a plain record. */
    env: TEnv;
    /** The originating message, for `setReject`/`forward`/`reply`. */
    message: ForwardableEmailMessageLike;
}

/** Routes a parsed message into a Cirrus function (or anywhere). */
type InboundDispatch<TEnv = Record<string, unknown>> = (email: InboundEmail, context: InboundDispatchContext<TEnv>) => Promise<void>;

/** Options for {@link createInboundEmailHandler}. */
interface InboundEmailHandlerOptions<TEnv = Record<string, unknown>> {
    /** Routes the parsed message onward (e.g. {@link dispatchToCirrusFunction}). */
    dispatch: InboundDispatch<TEnv>;

    /**
     * Called when `parse`/`dispatch` throws. The default rejects the message via
     * `message.setReject(reason)` so Cloudflare bounces/retries rather than
     * silently dropping it. Override to log, forward, or swallow.
     */
    onError?: (error: unknown, context: InboundDispatchContext<TEnv>) => Promise<void> | void;
    /** Parses raw bytes into an {@link InboundEmail} (e.g. `parseInboundEmail`). */
    parse: (raw: RawInboundEmail) => Promise<InboundEmail>;
}

/** The `email(message, env, ctx)` callback the factory returns. */
type InboundEmailHandler<TEnv = Record<string, unknown>> = (message: ForwardableEmailMessageLike, env: TEnv, context: unknown) => Promise<void>;

/** Default `onError`: reject the message so Cloudflare reports a permanent failure. */
const rejectOnError = <TEnv = Record<string, unknown>>(error: unknown, context: InboundDispatchContext<TEnv>): void => {
    context.message.setReject(error instanceof Error ? error.message : String(error));
};

/**
 * Build the `email(message, env, ctx)` handler. It (a) reads `message.raw`,
 * (b) parses it via `parse`, then (c) calls `dispatch(parsed, { message, env,
 * ctx })`. Any throw routes through `onError` (default: `message.setReject`).
 */
const createInboundEmailHandler = <TEnv = Record<string, unknown>>(options: InboundEmailHandlerOptions<TEnv>): InboundEmailHandler<TEnv> => {
    const onError = options.onError ?? rejectOnError;

    return async (message, env, context_) => {
        const context: InboundDispatchContext<TEnv> = { ctx: context_, env, message };

        try {
            const parsed = await options.parse(message.raw);

            await options.dispatch(parsed, context);
        } catch (error) {
            await onError(error, context);
        }
    };
};

/** The `RpcEnvelope` shape the runtime's `/_cirrus/rpc` path consumes. */
interface RpcEnvelope {
    args: unknown;
    functionPath: string;
    shardKey?: string;
}

/** Options for {@link dispatchToCirrusFunction}. */
interface DispatchToCirrusFunctionOptions<TEnv = Record<string, unknown>> {
    /**
     * Admin bearer authorizing the shard RPC. Defaults to reading
     * `env.CIRRUS_ADMIN_TOKEN` at dispatch time.
     */
    adminToken?: string;
    /** `functionPath` of the target mutation/action (e.g. `"inbound:onEmail"`). */
    functionPath: string;

    /**
     * Map the parsed message into the function's args. Defaults to passing the
     * whole {@link InboundEmail}.
     */
    resolveArgs?: (email: InboundEmail, context: InboundDispatchContext<TEnv>) => unknown;
    /** The `SHARD` Durable Object namespace. */
    shard: ShardNamespaceLike;
    /** Shard the function runs on. Defaults to the runtime's default root shard. */
    shardKey?: string;
}

const DEFAULT_ROOT_SHARD = "__root__";

/**
 * Build a {@link InboundDispatch} that posts an {@link RpcEnvelope} to the root
 * shard stub — the same admin-RPC-over-shard path the dev capture sink uses
 * (`from-env.ts`) — routing the parsed message into a named Cirrus
 * mutation/action. Throws on a non-2xx RPC or a missing admin token so the
 * handler's `onError` (default `setReject`) bounces the message.
 */
const dispatchToCirrusFunction = <TEnv extends Record<string, unknown> = Record<string, unknown>>(
    options: DispatchToCirrusFunctionOptions<TEnv>,
): InboundDispatch<TEnv> => {
    const shardKey = options.shardKey ?? DEFAULT_ROOT_SHARD;
    const resolveArgs = options.resolveArgs ?? ((email: InboundEmail) => email);

    return async (email, context) => {
        const adminToken = options.adminToken ?? (typeof context.env["CIRRUS_ADMIN_TOKEN"] === "string" ? context.env["CIRRUS_ADMIN_TOKEN"] : undefined);

        if (adminToken === undefined || adminToken === "") {
            throw new Error("@cirrus/mail/inbound: missing CIRRUS_ADMIN_TOKEN — cannot authorize inbound dispatch to the shard RPC.");
        }

        const envelope: RpcEnvelope = {
            args: resolveArgs(email, context),
            functionPath: options.functionPath,
            shardKey,
        };

        const stub = options.shard.get(options.shard.idFromName(shardKey));
        const response = (await stub.fetch("https://shard.internal/rpc", {
            body: JSON.stringify(envelope),
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
            method: "POST",
        })) as { json: () => Promise<unknown>; ok?: boolean; status?: number };

        // A shard stub returns a Fetch `Response`; treat a non-2xx (or an error
        // envelope) as a dispatch failure so the message is rejected upstream.
        if (response.ok === false) {
            throw new Error(`@cirrus/mail/inbound: dispatch to \`${options.functionPath}\` failed (HTTP ${String(response.status ?? "?")}).`);
        }

        const body: unknown = await response.json();

        if (typeof body === "object" && body !== null && "error" in body) {
            const { error } = body as { error?: unknown };

            if (error !== undefined && error !== null) {
                throw new Error(`@cirrus/mail/inbound: dispatch to \`${options.functionPath}\` returned an error: ${JSON.stringify(error)}`);
            }
        }
    };
};

export { createInboundEmailHandler, dispatchToCirrusFunction };
export type {
    DispatchToCirrusFunctionOptions,
    ForwardableEmailMessageLike,
    InboundDispatch,
    InboundDispatchContext,
    InboundEmailHandler,
    InboundEmailHandlerOptions,
    RpcEnvelope,
};
