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
 * ## Only read-only statements retry
 *
 * Every error below is **ambiguous about whether the statement applied**. "The
 * connection dropped" does not say whether it dropped before or after the write
 * committed, and D1 has no interactive transactions to resolve it.
 *
 * So the automatic paths ({@link retryingExec}, `D1Session.all` / `.first`)
 * retry a statement only when its leading keyword is `SELECT`, `PRAGMA` or
 * `EXPLAIN`. The method is not the signal: D1 runs
 * `UPDATE … RETURNING` through `.all()` exactly like `.run()`, and
 * `@lunora/sql-store` does precisely that for its optimistic-concurrency
 * compare-and-swap. Re-running one of those after a lost response either
 * double-applies the write or — for the compare-and-swap shape — comes back
 * with an empty `RETURNING` set and reports a conflict for a write that
 * actually landed.
 *
 * Writes that are genuinely idempotent — an upsert on a primary key, a delete
 * by id — can still opt in by calling {@link withD1Retry} directly.
 *
 * ## Retrying without a timeout makes a stall worse
 *
 * D1's reported failure mode is not only a fast error — it is a **stall**.
 * Operators report the storage object hanging for 30+ seconds before it resets,
 * several times a day, on databases holding tens of megabytes.
 *
 * A retry loop wrapped around a stall *amplifies* it: three attempts at 30
 * seconds each is a 90-second request instead of a 30-second one. Set
 * {@link D1RetryOptions.timeoutMs} to abandon an attempt that has clearly hung,
 * and {@link D1RetryOptions.deadlineMs} to bound the whole operation. With
 * neither configured this layer refuses to retry a *slow* failure at all (see
 * {@link SLOW_FAILURE_MS}), so the default configuration helps with fast errors
 * instead of compounding slow ones.
 *
 * **A timeout abandons the wait, not the work.** There is no way to cancel an
 * in-flight D1 operation from a Worker, so the subrequest continues and still
 * counts against the request's subrequest budget. What the timeout buys is that
 * the caller's request stops waiting — which is the difference between a user
 * seeing a fast error and a user watching a spinner for half a minute.
 * @experimental
 */
import { LunoraError, unreachable } from "@lunora/errors";
import type { SqlCtxExec } from "@lunora/sql-store";

/**
 * Substrings identifying a D1 failure that is worth retrying, taken from
 * Cloudflare's own accounting of the errors a healthy database produces.
 *
 * Matched as substrings because D1 wraps them with varying prefixes
 * (`D1_ERROR:`, `Error in D1 ...`) and appends request ids.
 *
 * Deliberately specific. A generic needle like `"internal error"` also matches
 * `D1_ERROR: internal error: too many SQL variables`, which is deterministic —
 * it fails identically on every attempt — and matching it would force a deny
 * list of deterministic phrasings to patch the over-match back out.
 *
 * Two entries here are judgement calls rather than certainties.
 * `exceeded its memory limit` and `storage operation exceeded timeout` are
 * transient when the isolate was recycled under unrelated load, and
 * deterministic when the query is simply too big for D1 to serve — in which
 * case the retries are wasted work before the same failure surfaces.
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
] as const;

/** Default number of attempts, including the first. */
const DEFAULT_ATTEMPTS = 3;

/** Base delay in ms; doubles each attempt. */
const BASE_DELAY_MS = 50;

/** Ceiling on any single backoff wait, in ms. */
const MAX_DELAY_MS = 1000;

/**
 * A failed attempt slower than this was a stall, not a blip — so when the
 * caller configured neither {@link D1RetryOptions.timeoutMs} nor
 * {@link D1RetryOptions.deadlineMs}, it is not retried.
 *
 * Without this the shipped defaults are the amplifying configuration the module
 * warns about: three attempts, no bound, one 30-second D1 hang becoming a
 * 90-second request. The threshold costs nothing on the failure mode retries
 * exist for (a dropped connection comes back in milliseconds) and refuses only
 * the case where retrying makes the outage worse.
 */
const SLOW_FAILURE_MS = 2000;

/** Statements safe to run twice: they cannot have applied anything. */
const READ_ONLY_STATEMENT = /^[\s(]*(?:select|pragma|explain)\b/iu;

/**
 * True when `sql` is a statement that can be re-run without applying anything
 * twice.
 *
 * Conservative on purpose. `WITH …` is excluded even though a SQLite CTE is
 * usually a read, because `WITH x AS (…) UPDATE …` is not; a statement this
 * cannot prove read-only simply does not retry.
 */
const isReadOnlyD1Sql = (sql: string): boolean => READ_ONLY_STATEMENT.test(sql);

/** Tuning for {@link withD1Retry}. */
interface D1RetryOptions {
    /** Total attempts including the first. Default 3. Must be >= 1. */
    attempts?: number;

    /**
     * Total budget across every attempt and backoff, in ms. An attempt still
     * running when the budget expires is abandoned, and a backoff never sleeps
     * past it.
     *
     * `timeoutMs` bounds one attempt; this bounds the operation.
     */
    deadlineMs?: number;

    /** Sleep implementation. Injected so tests need no timers. */
    sleep?: (ms: number) => Promise<void>;

    /**
     * Abandon a single attempt that has not settled within this many ms, and
     * treat it as a transient failure.
     *
     * There is no default — a legitimate analytical query and a stalled one
     * look identical from outside, so the value has to come from what your
     * workload actually needs. Unset, {@link SLOW_FAILURE_MS} stops a slow
     * failure from being retried rather than guessing a bound for you.
     *
     * Only ever applied to operations that are safe to abandon. It does not
     * cancel the underlying D1 call.
     */
    timeoutMs?: number;
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

    return TRANSIENT_D1_ERRORS.some((needle) => message.includes(needle));
};

/**
 * Full-jitter backoff for `attempt`, capped at {@link MAX_DELAY_MS}.
 *
 * Jittered because without it every request that hit the same D1 blip retries
 * in lockstep and re-converges on the recovering database as one synchronised
 * wave — which is how a brief incident becomes a sustained one.
 */
const backoffMs = (attempt: number): number => {
    const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));

    // eslint-disable-next-line sonarjs/pseudo-random -- jitter spreads retry timing; it is not a security primitive and needs no CSPRNG
    return Math.round(Math.random() * ceiling);
};

const defaultSleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Thrown when an attempt is abandoned for exceeding
 * {@link D1RetryOptions.timeoutMs}.
 *
 * Its own class so a caller can tell "D1 hung" apart from "D1 returned an
 * error" — they have different remedies, and collapsing them hides which one
 * is happening.
 * @experimental
 */
class D1TimeoutError extends Error {
    /** Milliseconds waited before the attempt was abandoned. */
    public readonly timeoutMs: number;

    public constructor(timeoutMs: number) {
        super(`@lunora/d1: operation exceeded its ${String(timeoutMs)}ms timeout and was abandoned (the underlying D1 call may still be running)`);
        this.name = "D1TimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Race `operation` against a timer, resolving to whichever settles first.
 *
 * The timer is always cleared, including on the success path — a Worker that
 * leaves one armed per query keeps the isolate alive for no reason.
 */
const withTimeout = async <T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new D1TimeoutError(timeoutMs));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

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

    const sleep = options.sleep ?? defaultSleep;
    const { deadlineMs, timeoutMs } = options;
    const startedAt = Date.now();
    // With no bound configured at all, a slow failure is refused a retry
    // instead of being compounded. See SLOW_FAILURE_MS.
    const unbounded = deadlineMs === undefined && timeoutMs === undefined;
    /** Whatever is left of the operation's total budget; `Infinity` with no deadline. */
    const budgetLeft = (): number => (deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - (Date.now() - startedAt));

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // The deadline bounds this attempt, not just the decision to start
        // another one — it documents the operation's worst case, and checking
        // it only after a failure makes the real bound
        // `deadlineMs + timeoutMs + backoff`.
        const attemptBudgetMs = Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, Math.max(budgetLeft(), 0));
        const attemptStartedAt = Date.now();

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential retry is the mechanism
            return await (Number.isFinite(attemptBudgetMs) ? withTimeout(operation, attemptBudgetMs) : operation());
        } catch (error) {
            // An abandoned attempt is retryable by definition: nothing came
            // back, so there is no error to classify.
            const retryable = error instanceof D1TimeoutError || isTransientD1Error(error);
            const wasStall = unbounded && Date.now() - attemptStartedAt >= SLOW_FAILURE_MS;
            // Never sleep past the deadline either: waiting out a backoff the
            // budget cannot afford burns the caller's time to reach the same
            // failure.
            const remainingMs = budgetLeft();

            if (attempt === attempts || !retryable || wasStall || remainingMs <= 0) {
                throw error;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential backoff is the mechanism
            await sleep(Math.min(backoffMs(attempt), remainingMs));
        }
    }

    return unreachable("@lunora/d1: retry loop exited without returning or throwing");
};

/**
 * Wrap a `.global()` exec so its **read-only** statements retry D1's transient
 * failures.
 *
 * This is where the retry has to live to reach an application: `.global()`
 * tables run every read through the exec codegen builds over the raw D1
 * binding, not through a `D1Client`. `run` and `batch` are passed straight
 * through — they are the write path, and a transient D1 error does not say
 * whether the write applied.
 *
 * `all` is not the read path either. It only retries when
 * {@link isReadOnlyD1Sql} proves the statement is one, because `UPDATE …
 * RETURNING` runs through `all` too.
 * @experimental
 */
const retryingExec = (exec: SqlCtxExec, options?: D1RetryOptions): SqlCtxExec => {
    return {
        ...exec,
        all: async (sql, parameters) => (isReadOnlyD1Sql(sql) ? withD1Retry(async () => exec.all(sql, parameters), options) : exec.all(sql, parameters)),
    };
};

export type { D1RetryOptions };
export { D1TimeoutError, isReadOnlyD1Sql, isTransientD1Error, retryingExec, withD1Retry };
