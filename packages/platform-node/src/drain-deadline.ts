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
    /**
     * Work that failed while the drain waited for it (an alarm retry that could not be written), one readable entry each. Each
     * was also logged with its cause when it happened. A failure never stops the drain waiting for the rest.
     */
    failed: string[];
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

/**
 * A {@link DrainTimer} that expires with `deadline` rather than on its own schedule, so a drain run inside another one shares its
 * deadline instead of starting a second: an injected timer keeping one callback would otherwise drop the first.
 */
const timerBoundTo =
    (deadline: DrainDeadline): DrainTimer =>
    (_ms, onExpire) => {
        let armed = true;
        const forward = async (): Promise<void> => {
            await deadline.expired;

            if (armed) {
                onExpire();
            }
        };

        forward().catch(() => undefined);

        return () => {
            armed = false;
        };
    };

/** Something that drains and can say, synchronously, whether it is idle: a registry, a platform. */
interface Drainable {
    drain: (options?: DrainOptions) => Promise<DrainResult>;
    idle: () => boolean;
    /** What is running right now, re-read when the deadline passes: a part that drained early can have gained work since. */
    pending: () => string[];
}

/**
 * Drain several parts under one deadline until all of them are idle in the same pass. Work on one part can start work on
 * another after that one finished draining (a request handed between registries), so a pass that left any of them busy is
 * followed by another, until the deadline.
 */
const drainTogether = async (parts: ReadonlyArray<Drainable>, options?: DrainOptions): Promise<DrainResult> => {
    const deadline = startDrainDeadline(options);
    const timer = timerBoundTo(deadline);
    const failed: string[] = [];

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- each pass waits for what the last one let start
            const results = await Promise.all(parts.map(async (part) => part.drain({ timer })));

            failed.push(...results.flatMap((result) => result.failed));

            if (results.some((result) => result.timedOut)) {
                // Re-read from every part, not taken from the results: one that drained early and then gained work reports it.
                return { failed, pending: parts.flatMap((part) => part.pending()), timedOut: true };
            }

            if (parts.every((part) => part.idle())) {
                // One more pass, immediate for parts that are idle: it collects a failure recorded after a part's own drain
                // returned (work another part handed it, which failed), which the results above could not include.
                // eslint-disable-next-line no-await-in-loop -- a final sweep, run once, after every part is idle
                const sweep = await Promise.all(parts.map(async (part) => part.drain({ timer })));

                failed.push(...sweep.flatMap((result) => result.failed));

                return { failed, pending: [], timedOut: false };
            }
        }
    } finally {
        deadline.cancel();
    }
};

/** Wait for `work`, or for `deadline` to pass, whichever comes first. Resolves `true` when the work settled in time. */
const settlesBefore = async (work: Promise<unknown>, deadline: DrainDeadline): Promise<boolean> =>
    Promise.race([
        work.then(
            () => true,
            () => true,
        ),
        deadline.expired.then(() => false),
    ]);

export type { Drainable, DrainDeadline, DrainOptions, DrainResult, DrainTimer };
export { DEFAULT_DRAIN_TIMEOUT_MS, drainTogether, settlesBefore, startDrainDeadline, timerBoundTo };
