/**
 * Transient-failure retries for D1.
 *
 * D1 has a **documented, expected, non-zero baseline error rate**. Cloudflare's
 * own team describes a handful of errors every few hours as "not unexpected"
 * even on a healthy database, and their guidance is to "retry their query and
 * unless there is an underlying issue with the database, it should eventually
 * work". The failures are infrastructural — a storage object reset, an isolate
 * evicted for memory, a dropped connection — not anything a query can be
 * rewritten to avoid.
 *
 * Which means an application that does not retry has adopted D1's baseline
 * error rate as its own. This module is that retry layer.
 *
 * ## Reads and writes are not the same
 *
 * Every error below is **ambiguous about whether the statement applied**. "The
 * connection dropped" does not say whether it dropped before or after the write
 * committed, and D1 has no interactive transactions to resolve it.
 *
 * So reads retry automatically and writes do not. Silently re-running
 * `UPDATE accounts SET balance = balance - 10` because the response was lost is
 * how a retry layer turns a transient blip into a corrupted balance. Writes
 * that are genuinely idempotent — an upsert on a primary key, a delete by id —
 * can opt in per call.
 * @experimental
 */
import { LunoraError } from "@lunora/errors";

/**
 * Substrings identifying a D1 failure that is worth retrying, taken from
 * Cloudflare's own accounting of the errors a healthy database produces.
 *
 * Matched as substrings because D1 wraps them with varying prefixes
 * (`D1_ERROR:`, `Error in D1 ...`) and appends request ids.
 */
const TRANSIENT_D1_ERRORS = [
    // The storage object took too long and was recycled mid-operation.
    "storage operation exceeded timeout",
    // The classic dropped-connection error; by far the most common.
    "network connection lost",
    // The storage object failed to come up — nothing ran.
    "internal error while starting up d1 db storage",
    // The isolate was evicted for memory. Entirely inside Cloudflare's runtime;
    // no query rewrite avoids it.
    "exceeded its memory limit",
    // The generic form of "your object was recycled, try again".
    "caused object to be reset",
    // Cloudflare's own transient-failure marker.
    "internal error",
] as const;

/** Default number of attempts, including the first. */
const DEFAULT_ATTEMPTS = 3;

/** Base delay in ms; doubles each attempt. */
const DEFAULT_BASE_DELAY_MS = 50;

/** Ceiling on any single backoff wait, in ms. */
const DEFAULT_MAX_DELAY_MS = 1000;

/** Tuning for {@link withD1Retry}. */
interface D1RetryOptions {
    /** Total attempts including the first. Default 3. Must be >= 1. */
    attempts?: number;

    /** First backoff delay in ms, doubling each attempt. Default 50. */
    baseDelayMs?: number;

    /**
     * Classify an error as retryable. Defaults to {@link isTransientD1Error}.
     * Override to narrow it — never to widen it past errors you know are safe
     * to re-run.
     */
    isRetryable?: (error: unknown) => boolean;

    /** Ceiling on a single backoff wait, in ms. Default 1000. */
    maxDelayMs?: number;

    /** Called before each retry — for logging or metrics. */
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;

    /** Sleep implementation. Injected so tests need no timers. */
    sleep?: (ms: number) => Promise<void>;
}

/** Extract a comparable message from an unknown thrown value. */
const messageOf = (error: unknown): string => {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`.toLowerCase();
    }

    return typeof error === "string" ? error.toLowerCase() : "";
};

/**
 * True when `error` looks like one of D1's expected transient failures.
 *
 * Deliberately conservative: an unrecognised error is treated as **permanent**
 * and surfaces immediately. Retrying a genuine bug — a syntax error, a
 * constraint violation — turns one fast failure into three slow ones and
 * hides the cause.
 * @experimental
 */
const isTransientD1Error = (error: unknown): boolean => {
    const message = messageOf(error);

    if (message.length === 0) {
        return false;
    }

    // A constraint violation is deterministic: it will fail identically on
    // every attempt, and its message can contain "internal error" in some
    // driver wrappings. Never retry it.
    if (message.includes("constraint") || message.includes("syntax error") || message.includes("no such table") || message.includes("no such column")) {
        return false;
    }

    return TRANSIENT_D1_ERRORS.some((needle) => message.includes(needle));
};

const defaultSleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Run `operation`, retrying D1's transient failures with exponential backoff
 * and jitter.
 *
 * **Only wrap operations that are safe to run more than once.** Reads always
 * are. A write is only if it is idempotent — an upsert keyed on a primary key,
 * a delete by id, an `INSERT OR IGNORE`. A bare `INSERT` or a relative
 * `UPDATE` is not, and re-running one after a lost response double-applies it.
 * @experimental
 */
const withD1Retry = async <T>(operation: () => Promise<T>, options: D1RetryOptions = {}): Promise<T> => {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;

    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new LunoraError("BAD_REQUEST", "@lunora/d1: `attempts` must be an integer >= 1");
    }

    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const isRetryable = options.isRetryable ?? isTransientD1Error;
    const sleep = options.sleep ?? defaultSleep;

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential retry is the mechanism
            return await operation();
        } catch (error) {
            lastError = error;

            if (attempt === attempts || !isRetryable(error)) {
                throw error;
            }

            // Full jitter. Without it, every request that hit the same D1 blip
            // retries in lockstep and re-converges on the recovering database
            // as one synchronised wave — which is how a brief incident becomes
            // a sustained one.
            const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            // eslint-disable-next-line sonarjs/pseudo-random -- jitter spreads retry timing; it is not a security primitive and needs no CSPRNG
            const delayMs = Math.round(Math.random() * ceiling);

            options.onRetry?.({ attempt, delayMs, error });

            // eslint-disable-next-line no-await-in-loop -- sequential backoff is the mechanism
            await sleep(delayMs);
        }
    }

    // Unreachable: the final attempt either returns or throws above. Present so
    // the function has a definite return for every path.
    throw lastError;
};

export type { D1RetryOptions };
export { isTransientD1Error, TRANSIENT_D1_ERRORS, withD1Retry };
