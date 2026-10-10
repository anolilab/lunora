/**
 * The durable-write replay policy: which failures leave a queued write eligible
 * for another attempt, how long the outbox waits before that attempt, and how
 * big a batched replay body may get.
 *
 * Module-level and pure, so it is testable without a client, a socket or a
 * `fetch`. The `LunoraClient` methods that use it (`rpc`, `replaySequential`,
 * `replayBatched`, `settleWholeBatchError`) stay orchestration.
 */
import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError } from "@lunora/errors";

import { AUTH_REPLAY_ERROR_CODES, getRetryAfterMs, TransportError } from "./errors";
import { retryAfterHeaderMs } from "./wire-errors";

/**
 * Coded errors that a durable-write replay **re-queues** for the next attempt
 * instead of settling terminally, because the server reached no verdict on the
 * write.
 *
 * `SHARD_UNAVAILABLE` / `SHARD_ERROR` mean the worker couldn't reach the shard,
 * or its response was unusable/partial — for a single-shard outbox flush these
 * fail every entry uniformly. `RATE_LIMITED` / `TOO_MANY_REQUESTS` mean a limiter
 * refused to look at the write at all (both are 429 in the catalog; the runtime's
 * REST limiter mints the first). "Not now" is not "no": dropping a durable write
 * because the client reconnected into a rate-limit window is exactly what the
 * outbox exists to prevent, and the retry hint rides back through
 * `replayRetryDelayMs`.
 *
 * Every other coded error is a server verdict (terminal) — replaying it would
 * re-trigger the same failure (a poison-message loop).
 */
const TRANSIENT_REPLAY_ERROR_CODES = new Set(["RATE_LIMITED", "SHARD_ERROR", "SHARD_UNAVAILABLE", "TOO_MANY_REQUESTS"]);

/**
 * Whether a single-call replay failure leaves the durable write eligible for
 * another attempt rather than settling it terminally.
 *
 * ONE rule shared with the batch path, because a queued write must not live or
 * die by how many siblings happened to be queued alongside it: a codeless
 * failure is a transport error (`fetch` rejected), a {@link
 * TRANSIENT_REPLAY_ERROR_CODES} code means the server reached no verdict, an
 * {@link AUTH_REPLAY_ERROR_CODES} code means the credential was refused (not
 * the write), and a {@link TransportError} is a transport failure wearing an
 * `INTERNAL` code — which is what an edge 502 HTML page arrives as.
 */
const isTransientReplayFailure = (error: unknown): boolean => {
    if (error instanceof TransportError) {
        return true;
    }

    const code = (error as { code?: string } | null | undefined)?.code;

    return code === undefined || TRANSIENT_REPLAY_ERROR_CODES.has(code) || AUTH_REPLAY_ERROR_CODES.has(code);
};

/** Longest delay a `Retry-After` hint can push the next outbox flush out by — a server (or a proxy) asking for an hour must not strand the queue for one. */
const MAX_REPLAY_RETRY_DELAY_MS = 60_000;

/** Shortest wait a hintless retryable failure backs off by, doubled per consecutive failure up to {@link MAX_REPLAY_RETRY_DELAY_MS}. */
const BASE_REPLAY_RETRY_DELAY_MS = 1000;

/**
 * Coded error a response the client could NOT read a `{ error }` envelope out of
 * is reported as, keyed by HTTP status. Anything else 4xx falls back to
 * `BAD_REQUEST` — see `unparseableResponseError` for which statuses reach
 * this table at all.
 */
const UNPARSEABLE_STATUS_CODES: Record<number, LunoraErrorCode> = {
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    413: "PAYLOAD_TOO_LARGE",
    429: "TOO_MANY_REQUESTS",
};

/**
 * The error a response the client could not read a Lunora `{ error }` envelope
 * out of arrives as: an HTML 502 from a gateway, a captive-portal redirect, a WAF
 * block page, a truncated body. The HTTP status is then the only verdict there
 * is, and the outbox needs one — unclassified, the head of the queue is neither
 * retried nor discarded and every write behind it waits forever.
 *
 * Split the way the outbox splits. `408`, every `5xx`, and any status outside
 * 400-599 leave the write's fate UNKNOWN — it may well have committed at the
 * origin behind the proxy — so they arrive as a {@link TransportError} and the
 * durable write is re-queued. Every other `4xx` is a definite refusal of the
 * REQUEST that sending it again can only reproduce, so it arrives coded and
 * settles the write terminally: dropping a write the edge refused is the lesser
 * harm against wedging every write queued behind it, which is the failure this
 * classification exists to end. `429` is coded too — a bare limiter page still
 * reads as rate limiting to an app — but its code is transient, so it re-queues.
 *
 * Any `Retry-After` is folded in as `data.retryAfterMs` at construction, because
 * that is the one channel the hint travels on and these errors are built, not
 * reconstructed from an envelope a server sent.
 */
const unparseableResponseError = (status: number, statusText: string, retryAfterHeader: null | string): LunoraError => {
    const hint = retryAfterHeaderMs(retryAfterHeader);
    const data = hint === undefined ? undefined : { retryAfterMs: hint };
    const message = `LunoraClient: response carried no error envelope (status ${status.toString()}${statusText ? ` ${statusText}` : ""})`;

    if (status < 400 || status >= 500 || status === 408) {
        return new TransportError(message, data);
    }

    return new LunoraError(UNPARSEABLE_STATUS_CODES[status] ?? "BAD_REQUEST", message, { data });
};

/**
 * Backoff for a retryable failure that named no time to come back: exponential
 * in `attempt` from {@link BASE_REPLAY_RETRY_DELAY_MS}, capped at
 * {@link MAX_REPLAY_RETRY_DELAY_MS}, then jittered across the top half of that
 * ceiling so a fleet of clients refused by ONE limiter does not re-converge on
 * the same instant and refuse itself again.
 *
 * `random` is injected the way `createReconnect`'s is, and for the same reason:
 * the two are the same equal-jitter calculation, and a test that has to stub a
 * global to pin a delay pins it for everything else in the file too.
 */
const defaultReplayRetryDelayMs = (attempt: number, random: () => number = Math.random): number => {
    const ceiling = Math.min(BASE_REPLAY_RETRY_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_REPLAY_RETRY_DELAY_MS);

    return Math.round(ceiling * (0.5 + random() * 0.5));
};

/**
 * Whether a transient failure came back FROM a server or an edge — a retryable
 * code, or a status `unparseableResponseError` had to classify itself —
 * rather than from a `fetch` that never landed.
 *
 * The two need different treatment: the socket stays open through a 429 or a
 * 503, so nothing else will ever schedule the flush again, whereas a `fetch`
 * that never landed means the device is offline and the reconnect that follows
 * flushes the queue anyway.
 */
const isAnsweredReplayFailure = (error: unknown): boolean =>
    error instanceof TransportError || TRANSIENT_REPLAY_ERROR_CODES.has((error as { code?: string } | null | undefined)?.code ?? "");

/**
 * How long a transient replay should wait before trying again, given how many
 * consecutive flushes of this shard key have now failed.
 *
 * A hint the server sent wins: the `data.retryAfterMs` the error carries — its
 * own, or a `Retry-After` header folded on via `retryAfterData` — clamped
 * to {@link MAX_REPLAY_RETRY_DELAY_MS}. Without one, a failure that was still
 * ANSWERED gets {@link defaultReplayRetryDelayMs}, because a hintless 429 or 503
 * arrives over a socket that stays open: with nothing scheduled the queued write
 * waits for a reconnect that a healthy connection never makes.
 *
 * `undefined` for a failure that never reached a server, which is the one case
 * the reconnect already covers.
 */
const replayRetryDelayMs = (error: unknown, attempt: number, random?: () => number): number | undefined => {
    const hint = getRetryAfterMs(error);

    if (hint !== undefined && hint > 0) {
        return Math.min(hint, MAX_REPLAY_RETRY_DELAY_MS);
    }

    return isAnsweredReplayFailure(error) ? defaultReplayRetryDelayMs(attempt, random) : undefined;
};

/**
 * Byte budget a batched replay holds its request body to. The worker refuses a
 * `/_lunora/rpc-batch` body over 1 MiB with a `413 PAYLOAD_TOO_LARGE`
 * (`MAX_BODY_BYTES`, `@lunora/runtime`'s `body-readers.ts`) — and a 413 is one
 * refusal covering a whole chunk of durable writes, so chunking by entry count
 * alone drops up to `MAX_BATCH_ENTRIES` writes the moment the backlog averages a
 * couple of KiB each. The 64 KiB of headroom covers the request framing the
 * server's cap counts and this measurement does not.
 */
const MAX_BATCH_BODY_BYTES = 1_048_576 - 65_536;

/**
 * UTF-8 byte length of `text`. Guarded because `TextEncoder` is not universal
 * across the runtimes this client ships to; an under-count only costs one wasted
 * round trip, since the `413` split-and-retry in `LunoraClient.replayBatched` is
 * the authoritative bound either way.
 */
const utf8ByteLength = (text: string): number => (typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length);

/** Errors {@link undecodableResultError} minted — recognised by identity, never by a code a peer could also send. */
const undecodableResults = new WeakSet<Error>();

/**
 * The error a SUCCESSFUL reply is reported as when its `result` does not
 * decode. The write it answers has committed — the server said so — so a
 * replay must settle it rather than classify it: left codeless it read as a
 * transport failure and replayed forever (the same reply every time), and
 * thrown out of a batch demux it abandoned every later slot for the session.
 */
const undecodableResultError = (cause: unknown): LunoraError => {
    const error = new LunoraError(
        "WIRE_DECODE_FAILED",
        `LunoraClient: the call succeeded but its result could not be decoded (a mutation has still committed) — ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
    );

    undecodableResults.add(error);

    return error;
};

/** Whether `error` reports a committed reply whose result did not decode (see {@link undecodableResultError}). */
const isUndecodableResult = (error: unknown): error is LunoraError => error instanceof Error && undecodableResults.has(error);

export {
    defaultReplayRetryDelayMs,
    isTransientReplayFailure,
    isUndecodableResult,
    MAX_BATCH_BODY_BYTES,
    replayRetryDelayMs,
    undecodableResultError,
    unparseableResponseError,
    utf8ByteLength,
};

export { errorEnvelopeOf, retryAfterData, retryAfterHeaderMs, type RpcEnvelopeBody, unreadableSlotError } from "./wire-errors";
