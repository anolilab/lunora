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
 * - `dispatchToLunoraFunction` marks the shard RPC a **trusted system dispatch**
 *   (the same marker the scheduler/cron path sets), so the target may be an
 *   `internalMutation`/`internalAction` — and it should be, because a public
 *   `mutation` reachable this way is equally reachable from any browser client,
 *   which can forge the whole message. The dispatch carries no caller identity,
 *   so an `rls()` policy on the target sees an anonymous caller rather than
 *   being bypassed. Combined with the spoofable sender, an inbound function must
 *   treat its input as fully attacker-controlled and do its own authorization.
 * - `onError` reasons are delivered to the (attacker-controlled) sender as a
 *   bounce, so the default never reflects internal error detail (see
 *   `rejectOnError`).
 */
/* eslint-enable jsdoc/check-indentation, jsdoc/no-multi-asterisks */
import { LunoraError } from "@lunora/errors";

import { toBase64 } from "../../../../shared/base64";
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

    /**
     * Reject the message with a PERMANENT SMTP error — Cloudflare returns it to
     * the connecting client with this reason, and it is never redelivered.
     * Documented at https://developers.cloudflare.com/email-routing/email-workers/runtime-api/
     * ("Reject this email message by returning a permanent SMTP error back to
     * the connecting client, including the given reason") and mirrored in
     * workerd's own `types/defines/email.d.ts`.
     */
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
 * `email.authentication`, an allow-list, etc.
 *
 * `true` and `undefined` are the ONLY answers that proceed — `undefined` so a
 * `(): void` hook that rejects by throwing type-checks. Anything else is read as a
 * rejection: this is the gate whose failure mode would otherwise grant.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- public API: `void` lets a verify hook with no explicit return (`() => {}`) type-check; `undefined` alone wouldn't accept a `(): void` arrow
type InboundVerify<TEnv = Record<string, unknown>> = (email: InboundEmail, context: InboundDispatchContext<TEnv>) => Promise<boolean | void> | boolean | void;

/**
 * Opt-in durable sink for a failed `dispatch`. Hand the parsed message to
 * something that owns the retry — a queue producer, a Durable Object, an alarm
 * — and the handler ACCEPTS the SMTP session instead of bouncing, because the
 * message is now owned rather than lost. Returning normally means "I have it";
 * throwing means the hand-off itself failed and the message bounces with the
 * generic reason (see {@link createInboundEmailHandler}).
 *
 * `error` is the dispatch failure, for classification/logging by the sink.
 *
 * NOTE: binary attachment `content` is an `ArrayBuffer`/`Uint8Array`, which
 * survives structured clone (Cloudflare Queues, DO storage) but is corrupted by
 * `JSON.stringify` — encode it yourself if the sink is JSON-bodied.
 */
type InboundRetain<TEnv = Record<string, unknown>> = (email: InboundEmail, context: InboundDispatchContext<TEnv>, error: unknown) => Promise<void> | void;

/** Options for {@link createInboundEmailHandler}. */
interface InboundEmailHandlerOptions<TEnv = Record<string, unknown>> {
    /** Routes the parsed message onward (e.g. {@link dispatchToLunoraFunction}). */
    dispatch: InboundDispatch<TEnv>;

    /**
     * Called when `parse`, `verify`, or `dispatch` fails — but with two DIFFERENT
     * contracts, because only the first two decide the message's fate here:
     *
     * - `parse` / `verify` — this hook DECIDES the outcome. The default
     * ({@link rejectOnError}) rejects via `message.setReject`; supplying your own
     * replaces that, so the message is accepted unless you reject it yourself.
     * - `dispatch` — this hook is OBSERVABILITY ONLY. It is called for the side
     * effect (log, alert, forward) and the outcome is then decided by `retain`
     * (accept) or a generic reject, regardless of what it does; the built-in
     * default is deliberately NOT applied there. A `setReject` from inside it
     * still takes effect, which would bounce a message `retain` went on to
     * accept — almost certainly not what you want. A throw from the hook itself
     * is logged and swallowed so it cannot mask the original dispatch error.
     *
     * SECURITY: a reject reason is delivered to the (attacker-controlled) sender
     * as a bounce, so the default reason is a fixed, generic string and the real
     * error is logged server-side. Never pass internal error text to `setReject`.
     */
    onError?: (error: unknown, context: InboundDispatchContext<TEnv>) => Promise<void> | void;
    /** Parses raw bytes into an {@link InboundEmail} (e.g. `parseInboundEmail`). */
    parse: (raw: RawInboundEmail) => Promise<InboundEmail>;

    /**
     * Opt-in: take durable ownership of a message whose `dispatch` failed, so a
     * transient fault (a shard 502, a briefly-absent admin token) is retried
     * instead of bounced. Omit it and a dispatch failure bounces, as it always
     * has. See {@link InboundRetain}.
     */
    retain?: InboundRetain<TEnv>;

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
 * server-side, never reflected to the sender's bounce. Only reached for
 * `parse`/`verify` failures, which are permanent by nature.
 */
const rejectOnError = <TEnv = Record<string, unknown>>(error: unknown, context: InboundDispatchContext<TEnv>): void => {
    // eslint-disable-next-line no-console -- intentional server-side log of the detailed error before rejecting with a generic, non-reflecting reason
    console.error("@lunora/mail/inbound: dropping message —", error);

    context.message.setReject(GENERIC_REJECT_REASON);
};

/**
 * Build the `email(message, env, ctx)` handler. It (a) reads `message.raw`,
 * (b) parses it via `parse`, (c) runs the optional `verify` gate, then
 * (d) calls `dispatch(parsed, { message, env, ctx })`.
 *
 * The two failure classes are routed differently:
 *
 * - `parse` / `verify` (including a falsy `verify`) → `onError` (default: a
 * generic `message.setReject`). A malformed or unauthenticated message fails
 * the same way on every redelivery, so bouncing it is the honest answer.
 * - `dispatch` (or its transport) → a custom `onError` is called for
 * observability, then the message is handed to `retain` if one is configured
 * (SMTP ACCEPTs — the retry is now owned elsewhere) and otherwise bounced with
 * the same generic reason. A `retain` that throws bounces too.
 *
 * WHY THE RETRY IS ABSORBED IN-WORKER RATHER THAN SIGNALLED OVER SMTP — there is
 * no transient-reject API and no inbound redelivery to appeal to:
 *
 * - `setReject` is documented as a PERMANENT SMTP error
 * (https://developers.cloudflare.com/email-routing/email-workers/runtime-api/),
 * with no "try later" variant.
 * - Cloudflare does not document what an uncaught throw from `email()` does. The
 * full Email Routing and Email Service docs corpora
 * (`developers.cloudflare.com/email-routing/llms-full.txt`,
 * `.../email-service/llms-full.txt`) say nothing about an unhandled exception,
 * and describe NO redelivery mechanism for inbound Email Workers at all. The
 * documented lifecycle
 * (https://developers.cloudflare.com/email-service/concepts/email-lifecycle/)
 * lists exactly three worker outcomes — `forward()`, `reply()`, `setReject()` —
 * with no branch for "the worker threw". (Its 4xx-retry prose is about OUTBOUND
 * delivery to the destination MTA, not about invoking the worker.)
 * - The behaviour reported in practice is a PERMANENT in-session rejection:
 * `521 5.3.0 Upstream error`, i.e. the same permanence as `setReject` but with
 * an opaque reason instead of ours. See
 * https://community.cloudflare.com/t/is-it-possible-to-return-a-transient-failure-from-an-email-worker/599938
 * ("If the email function raises an exception, a permanent failure is returned
 * to the client after the DATA command") — a question Cloudflare never answered
 * — and https://community.cloudflare.com/t/email-worker-upstream-error/457228.
 * Email Routing also states it forwards upstream SMTP errors back to the sender
 * in-session rather than generating a bounce later
 * (https://developers.cloudflare.com/email-service/reference/postmaster/#smtp-errors).
 *
 * So every SMTP-visible outcome is permanent, and the only way not to lose a
 * legitimate message to a two-second shard 502 is to accept it and take durable
 * ownership: that is `retain`. It stays opt-in — with no `retain`, a dispatch
 * failure bounces exactly as before.
 *
 * A dispatch that KNOWS one of its own failures is permanent should call
 * `context.message.setReject(...)` and return normally rather than throw, so it
 * bounces without being handed to `retain` (see `@lunora/agent`'s inbound
 * handler for both cases).
 */

/**
 * Whether a `verify` hook's answer admits the message — deny by default.
 *
 * `true` and `undefined` are the two documented "proceed" answers (`undefined` so
 * a `(): void` hook that rejects by throwing type-checks). EVERYTHING else — a
 * `null`, a `0`, an empty string out of a hook that forgot a branch — is a
 * rejection. Testing only for `=== false` made this the one gate in the package
 * whose failure mode granted access to the privileged dispatch.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- mirrors InboundVerify's public return type, which admits `void` for a no-return hook
const verifyPassed = (verified: boolean | void): boolean => verified === true || verified === undefined;

const createInboundEmailHandler = <TEnv = Record<string, unknown>>(options: InboundEmailHandlerOptions<TEnv>): InboundEmailHandler<TEnv> => {
    const onError = options.onError ?? rejectOnError;

    return async (message, env, context_) => {
        const context: InboundDispatchContext<TEnv> = { ctx: context_, env, message };
        let parsed: InboundEmail;

        try {
            parsed = await options.parse(message.raw);

            if (options.verify) {
                const verified = await options.verify(parsed, context);

                if (!verifyPassed(verified)) {
                    throw new LunoraError("INTERNAL", "@lunora/mail/inbound: sender verification rejected the message");
                }
            }
        } catch (error) {
            // Permanent by nature — a redelivery of the same bytes parses and
            // verifies exactly the same way.
            await onError(error, context);

            return;
        }

        try {
            await options.dispatch(parsed, context);
        } catch (error) {
            // A custom `onError` is the app's only observability hook on this
            // path — narrowing it to parse/verify meant an app that wired error
            // reporting into it saw no dispatch failure at all. It is called for
            // the side effect only; the outcome below is decided by `retain`.
            // The BUILT-IN default (`rejectOnError`) is deliberately skipped
            // here: it calls `setReject`, which would bounce a message `retain`
            // is about to accept.
            if (options.onError) {
                try {
                    await options.onError(error, context);
                } catch (hookError) {
                    // Never let the observability hook mask the real failure.
                    // eslint-disable-next-line no-console -- intentional server-side log; the message is rejected below regardless
                    console.error("@lunora/mail/inbound: onError threw while reporting a dispatch failure —", hookError);
                }
            }

            // Absorb the retry in-worker when the app supplied somewhere durable
            // to put the message: accept the SMTP session, because the message is
            // owned rather than lost. Cloudflare offers no transient-reject path
            // and no inbound redelivery (see the note above), so this is the only
            // outcome that survives a two-second shard 502.
            if (options.retain) {
                try {
                    await options.retain(parsed, context, error);

                    return;
                } catch (retainError) {
                    // The hand-off failed too — nothing durable owns the message,
                    // so fall through to the controlled permanent bounce below.
                    // eslint-disable-next-line no-console -- server-side log; the sender only ever sees the generic reason
                    console.error("@lunora/mail/inbound: retain failed to take ownership of the message —", retainError);
                }
            }

            // No durable sink (or it failed): both SMTP outcomes are permanent,
            // so pick the one whose reason we control — generic to the sender,
            // detailed in the server log.
            rejectOnError(error, context);
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
 * mutation/action. Throws on a non-2xx RPC or a missing admin token — both
 * transient in principle, so the handler reports it through a custom `onError`
 * and then hands the message to `retain` if one is configured, bouncing only
 * when there is nowhere durable to put it (see {@link createInboundEmailHandler}).
 *
 * SECURITY: the RPC is marked a trusted system dispatch, so `functionPath` may
 * (and should) name an `internalMutation`/`internalAction` — a public `mutation`
 * target is callable by any browser client with a forged message. The input is
 * fully attacker-controlled and spoofable; verify the sender (`verify` hook /
 * `email.authentication`) before making any trust decision in the target.
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
        // envelope check; a throw here reaches the handler's dispatch-failure
        // path (custom `onError` for observability, then `retain` or a bounce).
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
    InboundRetain,
    InboundVerify,
    RpcEnvelope,
};
