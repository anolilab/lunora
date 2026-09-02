/**
 * The durable-write replay policy: which failures leave a queued write eligible
 * for another attempt, how long the outbox waits before that attempt, and how
 * big a batched replay body may get.
 *
 * Module-level and pure, so it is testable without a client, a socket or a
 * `fetch`. The three `LunoraClient` methods that use it (`replaySingle`,
 * `replayBatched`, `settleWholeBatchError`) stay orchestration.
 */
import { getRetryAfterMs, TransportError } from "./errors";

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
 * {@link replayRetryDelayMs}.
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
 * TRANSIENT_REPLAY_ERROR_CODES} code means the server reached no verdict, and a
 * {@link TransportError} is a transport failure wearing an `INTERNAL` code —
 * which is what an edge 502 HTML page arrives as.
 */
const isTransientReplayFailure = (error: unknown): boolean => {
    if (error instanceof TransportError) {
        return true;
    }

    const code = (error as { code?: string } | null | undefined)?.code;

    return code === undefined || TRANSIENT_REPLAY_ERROR_CODES.has(code);
};

/** Longest delay a `Retry-After` hint can push the next outbox flush out by — a server (or a proxy) asking for an hour must not strand the queue for one. */
const MAX_REPLAY_RETRY_DELAY_MS = 60_000;

/** Parse a `Retry-After` header (whole seconds, as the runtime's REST limiter sends it) into milliseconds; `undefined` when absent or not a positive number. */
const retryAfterHeaderMs = (header: null | string): number | undefined => {
    const seconds = header === null ? Number.NaN : Number(header);

    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/**
 * The `data` an error should carry once a `Retry-After` response header is
 * folded in as `data.retryAfterMs` — the ONE channel a retry hint travels on.
 * `undefined` when the header adds nothing, so the caller leaves the error
 * untouched.
 *
 * The runtime's REST limiter sends whole seconds in the header where an
 * application limiter puts milliseconds in the error envelope's `data`. This
 * normalises the header form into the envelope form at the response boundary, so
 * `data.retryAfterMs` is the only place anything downstream has to look —
 * including `@lunora/client`'s public {@link getRetryAfterMs}, which an app calls
 * to render "try again in N seconds" and which never saw the header form.
 *
 * An envelope hint the server actually sent wins: it is the limiter's own
 * number, where the header is rounded to whole seconds. A non-object `data` is
 * left alone rather than overwritten — losing an unusual payload is worse than
 * losing a hint.
 */
const retryAfterData = (error: { data?: unknown }, header: null | string): Record<string, unknown> | undefined => {
    const hint = retryAfterHeaderMs(header);

    if (hint === undefined || getRetryAfterMs(error) !== undefined) {
        return undefined;
    }

    if (error.data === undefined) {
        return { retryAfterMs: hint };
    }

    return typeof error.data === "object" && error.data !== null && !Array.isArray(error.data)
        ? { ...(error.data as Record<string, unknown>), retryAfterMs: hint }
        : undefined;
};

/**
 * How long a rate-limited replay should wait before trying again: the
 * `data.retryAfterMs` the error carries — either the server's own, or a
 * `Retry-After` header folded on via {@link retryAfterData}. Clamped to
 * {@link MAX_REPLAY_RETRY_DELAY_MS}.
 */
const replayRetryDelayMs = (error: unknown): number | undefined => {
    const hint = getRetryAfterMs(error);

    return hint !== undefined && hint > 0 ? Math.min(hint, MAX_REPLAY_RETRY_DELAY_MS) : undefined;
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

export {
    isTransientReplayFailure,
    MAX_BATCH_BODY_BYTES,
    MAX_REPLAY_RETRY_DELAY_MS,
    replayRetryDelayMs,
    retryAfterData,
    retryAfterHeaderMs,
    TRANSIENT_REPLAY_ERROR_CODES,
    utf8ByteLength,
};
