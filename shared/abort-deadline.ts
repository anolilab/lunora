/**
 * Canonical "combine a caller's `signal` with a `timeoutMs` deadline" helper
 * for Worker-runtime code, shared across `@lunora/dispatch` and
 * `@lunora/container` (and any future Worker-runtime timeout).
 *
 * Deliberately an explicit `AbortController` + `setTimeout` rather than
 * `AbortSignal.timeout(ms)`. The built-in is **weakly held**: nothing in the
 * platform keeps the returned signal alive, so once the only strong reference
 * goes out of scope the signal can be collected and the deadline **silently
 * never fires** — a caller's `timeoutMs` becomes an unbounded call. That is not
 * theoretical: written with `AbortSignal.timeout` this failed roughly three runs
 * in eight, hanging until the test runner's own timeout. A controller captured
 * by the timer callback is strongly reachable for exactly as long as the timer
 * is pending, which is the lifetime we actually want.
 *
 * `dispose` is the other half: without it a call that answers in 5ms leaves a
 * 120s timer pending.
 *
 * Like `shared/constant-time-equal.ts`, deliberately **not** a package:
 * consumers import this file by relative path and the bundler inlines it — no
 * runtime dependency edge. Keep it genuinely zero-dependency (relative/built-in
 * imports only) or inlining breaks. Consumers must drop `outDir`/`rootDir`
 * from their `tsconfig.json` (a set `rootDir` raises TS6059 for this
 * out-of-package file under `tsc --noEmit`).
 */

/** A resolved deadline: the signal to send, plus the timer teardown. */
interface AbortDeadline {
    /** Clear the deadline timer. Always call in a `finally`, or a fast response leaves a pending timer. */
    dispose: () => void;
    /** The signal to hand `fetch`, or `undefined` when the call is unbounded. */
    signal: AbortSignal | undefined;
}

/**
 * Combine a caller's `signal` with a `timeoutMs` deadline; `reason` builds the
 * abort reason lazily so the (usually never-thrown) error is only constructed
 * when the deadline actually fires.
 */
const abortDeadline = (signal: AbortSignal | undefined, timeoutMs: number | undefined, reason: () => unknown): AbortDeadline => {
    if (timeoutMs === undefined) {
        return { dispose: () => {}, signal };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(reason());
    }, timeoutMs);

    return {
        dispose: () => {
            clearTimeout(timer);
        },
        signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
    };
};

export { type AbortDeadline, abortDeadline };
