/* eslint-disable jsdoc/check-indentation, jsdoc/no-multi-asterisks -- intentional nested bullet list + `*emphasis*` documenting the inbound security model */

/**
 * `createInboundEmailHandler()` — the inbound counterpart to the outbound
 * `cloudflareSend` callback-injection pattern (`cloudflare-transport.ts`).
 *
 * Cloudflare delivers inbound mail to a Worker's exported `email(message, env,
 * ctx)` handler, where `message` is a `ForwardableEmailMessage`. This factory
 * returns exactly that callback, typed against a **structural**
 * `ForwardableEmailMessageLike` so `@lunora/mail` needs no `cloudflare:email`
 * import — the host's generated entry supplies the real binding. The handler
 * reads `message.raw`, parses it, and dispatches the normalised message into a
 * Lunora mutation/action via a caller-supplied `dispatch`.
 *
 * `dispatchToLunoraFunction` is the batteries-included `dispatch`: it posts an
 * `RpcEnvelope` to the root shard stub over the same admin-RPC-over-shard path
 * the dev capture sink uses (`from-env.ts`).
 *
 * SECURITY — inbound mail is untrusted and dispatch runs privileged:
 * - Cloudflare Email Routing authenticates only the *recipient* domain, not the
 *   *sender*. The envelope `from` and message body are trivially spoofable, so a
 *   handler MUST NOT make trust/authorization decisions on `email.from`. Gate on
 *   `email.authentication` (DKIM/SPF/DMARC verdicts) and/or the `verify` hook.
 * - `dispatchToLunoraFunction` authenticates the shard RPC with the admin bearer
 *   (`LUNORA_ADMIN_TOKEN`), so the target function runs in a **system/admin
 *   context with RLS bypassed**. Combined with the spoofable sender, this means
 *   an inbound function must treat its input as fully attacker-controlled.
 * - `onError` reasons are delivered to the (attacker-controlled) sender as a
 *   bounce, so the default never reflects internal error detail (see
 *   `rejectOnError`).
 */
/* eslint-enable jsdoc/check-indentation, jsdoc/no-multi-asterisks */
import { LunoraError } from "@lunora/errors";

import type { InboundEmail, RawInboundEmail } from "./parse";
import type { DurableObjectJurisdiction, ShardNamespaceLike } from "./shard";
import { DEFAULT_ROOT_SHARD, postShardRpc } from "./shard";

/**
 * Structural projection of Cloudflare's `ForwardableEmailMessage` (verified
 * against `@cloudflare/workers-types`' `ForwardableEmailMessage`). Only the
 * members the handler touches are modelled, so the host can pass the real
 * runtime object without `@lunora/mail` importing `cloudflare:email`.
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

/** Routes a parsed message into a Lunora function (or anywhere). */
type InboundDispatch<TEnv = Record<string, unknown>> = (email: InboundEmail, context: InboundDispatchContext<TEnv>) => Promise<void>;

/**
 * Opt-in sender-verification gate. Runs after `parse` and before `dispatch` with
 * the parsed message. Return `false` (or throw) to reject the message before it
 * reaches the privileged dispatch — use it to enforce DKIM/SPF/DMARC via
 * `email.authentication`, an allow-list, etc. Returning `true`/`undefined`
 * proceeds.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- public API: `void` lets a verify hook with no explicit return (`() => {}`) type-check; `undefined` alone wouldn't accept a `(): void` arrow
type InboundVerify<TEnv = Record<string, unknown>> = (email: InboundEmail, context: InboundDispatchContext<TEnv>) => Promise<boolean | void> | boolean | void;

/** Options for {@link createInboundEmailHandler}. */
interface InboundEmailHandlerOptions<TEnv = Record<string, unknown>> {
    /** Routes the parsed message onward (e.g. {@link dispatchToLunoraFunction}). */
    dispatch: InboundDispatch<TEnv>;

    /**
     * Called when `parse`/`verify`/`dispatch` throws. The default rejects the
     * message via `message.setReject` so Cloudflare bounces/retries rather than
     * silently dropping it. SECURITY: the reject reason is delivered to the
     * (attacker-controlled) sender as a bounce, so the default reason is a fixed,
     * generic string and the real error is logged server-side. Override to log,
     * forward, or swallow — but never pass internal error text to `setReject`.
     */
    onError?: (error: unknown, context: InboundDispatchContext<TEnv>) => Promise<void> | void;
    /** Parses raw bytes into an {@link InboundEmail} (e.g. `parseInboundEmail`). */
    parse: (raw: RawInboundEmail) => Promise<InboundEmail>;

    /**
     * Opt-in sender-authentication gate run before `dispatch`. SECURITY: inbound
     * `from` is spoofable and dispatch is privileged — supply this (gating on
     * `email.authentication`) when an inbound function makes any trust decision.
     */
    verify?: InboundVerify<TEnv>;
}

/** The `email(message, env, ctx)` callback the factory returns. */
type InboundEmailHandler<TEnv = Record<string, unknown>> = (message: ForwardableEmailMessageLike, env: TEnv, context: unknown) => Promise<void>;

/**
 * Generic, fixed reject reason handed to the sender's MTA. SECURITY: never embed
 * internal error detail here — the reason is reflected to the (untrusted) sender
 * in the bounce (NDR).
 */
const GENERIC_REJECT_REASON = "message could not be processed";

/**
 * Default `onError`: reject the message so Cloudflare reports a permanent
 * failure, but with a fixed generic reason — the detailed error is logged
 * server-side, never reflected to the sender's bounce.
 */
const rejectOnError = <TEnv = Record<string, unknown>>(error: unknown, context: InboundDispatchContext<TEnv>): void => {
    // eslint-disable-next-line no-console -- intentional server-side log of the detailed error before rejecting with a generic, non-reflecting reason
    console.error("@lunora/mail/inbound: dropping message —", error);

    context.message.setReject(GENERIC_REJECT_REASON);
};

/**
 * Build the `email(message, env, ctx)` handler. It (a) reads `message.raw`,
 * (b) parses it via `parse`, (c) runs the optional `verify` gate, then
 * (d) calls `dispatch(parsed, { message, env, ctx })`. Any throw (or a falsy
 * `verify`) routes through `onError` (default: a generic `message.setReject`).
 */
const createInboundEmailHandler = <TEnv = Record<string, unknown>>(options: InboundEmailHandlerOptions<TEnv>): InboundEmailHandler<TEnv> => {
    const onError = options.onError ?? rejectOnError;

    return async (message, env, context_) => {
        const context: InboundDispatchContext<TEnv> = { ctx: context_, env, message };

        try {
            const parsed = await options.parse(message.raw);

            if (options.verify) {
                const verified = await options.verify(parsed, context);

                if (verified === false) {
                    throw new LunoraError("INTERNAL", "@lunora/mail/inbound: sender verification rejected the message");
                }
            }

            await options.dispatch(parsed, context);
        } catch (error) {
            await onError(error, context);
        }
    };
};

/** The `RpcEnvelope` shape the runtime's `/_lunora/rpc` path consumes. */
interface RpcEnvelope {
    args: unknown;
    functionPath: string;
    shardKey?: string;
}

/** Options for {@link dispatchToLunoraFunction}. */
interface DispatchToLunoraFunctionOptions<TEnv = Record<string, unknown>> {
    /**
     * Admin bearer authorizing the shard RPC. Defaults to reading
     * `env.LUNORA_ADMIN_TOKEN` at dispatch time.
     */
    adminToken?: string;
    /** `functionPath` of the target mutation/action (e.g. `"inbound:onEmail"`). */
    functionPath: string;

    /**
     * Pin inbound dispatch to a Cloudflare data-residency jurisdiction. Pass the
     * same value as the worker's `jurisdiction` so inbound mail routes to the
     * jurisdiction-pinned shard. Omit for the un-pinned global namespace.
     */
    jurisdiction?: DurableObjectJurisdiction;

    /**
     * Map the parsed message into the function's args. Defaults to passing the
     * whole {@link InboundEmail} with binary attachment `content` base64-encoded
     * (see {@link toJsonSafeEmail}) so it survives the JSON-serialised RPC body.
     */
    resolveArgs?: (email: InboundEmail, context: InboundDispatchContext<TEnv>) => unknown;
    /** The `SHARD` Durable Object namespace. */
    shard: ShardNamespaceLike;
    /** Shard the function runs on. Defaults to the runtime's default root shard. */
    shardKey?: string;
}

/** Chunk size for {@link toBase64}: kept ≤ the arg-spread limit `String.fromCharCode` tolerates. */
const BASE64_CHUNK = 0x80_00;

/** Base64-encode raw bytes without relying on Node's `Buffer` (workerd-safe). */
const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    // Build the latin1 string in ≤32KB chunks — orders of magnitude faster than
    // one `String.fromCodePoint` call per byte for multi-megabyte attachments,
    // while staying under the argument-count limit of a single spread call.
    for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
        // eslint-disable-next-line unicorn/prefer-code-point -- byte values 0-255 -> latin1; fromCharCode is correct and faster here
        binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
    }

    // `btoa` is available in both workerd and modern Node; it operates on the
    // latin1 string built above.
    return btoa(binary);
};

/**
 * Normalise an {@link InboundEmail} into a JSON-safe envelope for the RPC body.
 * Binary attachment `content` (postal-mime hands binary parts back as an
 * `ArrayBuffer`/`Uint8Array`) would be corrupted by `JSON.stringify` — an
 * `ArrayBuffer` serialises to `{}` and a `Uint8Array` to a bloated index-keyed
 * object. We base64-encode binary content and mark `encoding: "base64"` so it
 * survives the wire intact; string content is passed through untouched.
 */
const toJsonSafeEmail = (email: InboundEmail): InboundEmail => {
    if (email.attachments.length === 0) {
        return email;
    }

    return {
        ...email,
        attachments: email.attachments.map((attachment) => {
            const { content } = attachment;

            if (typeof content === "string") {
                return attachment;
            }

            const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);

            return { ...attachment, content: toBase64(bytes), encoding: "base64" as const };
        }),
    };
};

/**
 * Build a {@link InboundDispatch} that posts an {@link RpcEnvelope} to the root
 * shard stub — the same admin-RPC-over-shard path the dev capture sink uses
 * (`from-env.ts`) — routing the parsed message into a named Lunora
 * mutation/action. Throws on a non-2xx RPC or a missing admin token so the
 * handler's `onError` (default `setReject`) bounces the message.
 *
 * SECURITY: the RPC carries the admin bearer, so the target function runs with
 * RLS bypassed over fully attacker-controlled, spoofable input — see the module
 * docstring. Verify the sender (`verify` hook / `email.authentication`) before
 * making any trust decision in the target function.
 */
const dispatchToLunoraFunction = <TEnv extends Record<string, unknown> = Record<string, unknown>>(
    options: DispatchToLunoraFunctionOptions<TEnv>,
): InboundDispatch<TEnv> => {
    const shardKey = options.shardKey ?? DEFAULT_ROOT_SHARD;
    const resolveArgs = options.resolveArgs ?? ((email: InboundEmail) => toJsonSafeEmail(email));

    return async (email, context) => {
        const adminToken = options.adminToken ?? (typeof context.env["LUNORA_ADMIN_TOKEN"] === "string" ? context.env["LUNORA_ADMIN_TOKEN"] : undefined);

        if (adminToken === undefined || adminToken === "") {
            throw new LunoraError("INTERNAL", "@lunora/mail/inbound: missing LUNORA_ADMIN_TOKEN — cannot authorize inbound dispatch to the shard RPC.");
        }

        const envelope: RpcEnvelope = {
            args: resolveArgs(email, context),
            functionPath: options.functionPath,
            shardKey,
        };

        // The shared helper owns the URL, headers, `response.ok` check, and error
        // envelope check; a throw here routes through the handler's `onError`
        // (default `setReject`) so the message is rejected upstream.
        await postShardRpc(options.shard, {
            adminToken,
            envelope,
            jurisdiction: options.jurisdiction,
            label: `@lunora/mail/inbound: dispatch to \`${options.functionPath}\``,
            shardKey,
        });
    };
};

export { createInboundEmailHandler, dispatchToLunoraFunction };
export type {
    DispatchToLunoraFunctionOptions,
    ForwardableEmailMessageLike,
    InboundDispatch,
    InboundDispatchContext,
    InboundEmailHandler,
    InboundEmailHandlerOptions,
    InboundVerify,
    RpcEnvelope,
};
