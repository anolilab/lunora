/**
 * The deadline every `drain()` in this package runs under. A shutdown that waits for work without a bound is held open by the
 * one request or background task that never settles, until the supervisor's kill skips the database close the drain exists to
 * reach. Each drain returns what was still pending when its deadline passed, so the caller can log it and close anyway.
 */

/**
 * Arms `onExpire` to run after `ms` and returns a function that disarms it. Injectable so a test drives the deadline by hand
 * rather than waiting for a clock.
 */
type DrainTimer = (ms: number, onExpire: () => void) => () => void;

/** Options every `drain()` accepts. */
interface DrainOptions {
    /** Stop waiting after this many milliseconds. Defaults to {@link DEFAULT_DRAIN_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** The clock the deadline runs on. Defaults to `setTimeout`, which keeps the process alive until the drain settles or expires. */
    timer?: DrainTimer;
}

/** How a `drain()` ended. */
interface DrainResult {
    /** What was still running when the deadline passed, one human-readable entry each. Empty when the drain completed. */
    pending: string[];
    /** `true` when the deadline passed before the work settled. */
    timedOut: boolean;
}

/** Long enough for an ordinary request or background write to finish; short enough that a stuck one cannot stall a shutdown. */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

// Referenced on purpose. A drain can be waiting on a promise with no I/O behind it (a shard's stalled `waitUntil`), and once
// the HTTP sockets are gone nothing else holds the event loop open: an unref'd deadline let Node exit right there, before it
// fired, with nothing logged and no database closed. The drain cancels it as soon as it settles, so it holds nothing longer.
const deadlineTimer: DrainTimer = (ms, onExpire) => {
    const timeout = setTimeout(onExpire, ms);

    return () => {
        clearTimeout(timeout);
    };
};

/** A deadline: `expired` settles when it passes, and `cancel` disarms it once the work it bounds is done. */
interface DrainDeadline {
    cancel: () => void;
    expired: Promise<void>;
}

/** The longest delay a Node timer honours: a larger one, or a non-integer, runs after 1 ms. */
const MAX_DRAIN_TIMEOUT_MS = 2_147_483_647;

const startDrainDeadline = (options: DrainOptions = {}): DrainDeadline => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    // Refused rather than clamped: a timeout Node would run after 1 ms cuts the drain off at once, the opposite of the intent.
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_DRAIN_TIMEOUT_MS) {
        throw new RangeError(
            `@lunora/platform-node: a drain timeoutMs must be a whole number of milliseconds from 0 to ${String(MAX_DRAIN_TIMEOUT_MS)}, and it is ${String(timeoutMs)}`,
        );
    }

    let expire: () => void = () => {};
    const expired = new Promise<void>((resolve) => {
        expire = resolve;
    });
    const cancel = (options.timer ?? deadlineTimer)(timeoutMs, () => {
        expire();
    });

    return { cancel, expired };
};

/** Wait for `work`, or for `deadline` to pass, whichever comes first. Resolves `true` when the work settled in time. */
const settlesBefore = async (work: Promise<unknown>, deadline: DrainDeadline): Promise<boolean> =>
    Promise.race([work.then(() => true), deadline.expired.then(() => false)]);

export type { DrainDeadline, DrainOptions, DrainResult, DrainTimer };
export { DEFAULT_DRAIN_TIMEOUT_MS, settlesBefore, startDrainDeadline };
