import assertScheduleDelay from "./validate-delay";

/**
 * Reject a `runAt` instant a scheduler cannot act on — {@link assertScheduleDelay}'s
 * bound, restated for the absolute form by converting the instant to the delay it
 * implies.
 *
 * `runAfter` has refused a `NaN`/`Infinity` argument since the guard was written;
 * `runAt` took the same value through a different door and let it reach the DO,
 * where it serializes to `null` through JSON and lands as a `scheduledFor` no
 * alarm can ever fire. `new Date("2026-13-01")`, `runAt(row.dueAt + delay)` on a
 * row whose `dueAt` is absent — both arrive here as a number that is not one.
 *
 * An instant already in the PAST is not refused. It is an overdue job
 * (`runAt(row.dueAt)` on a row that came due while the request was in flight),
 * and `runAfter` itself reaches `runAt` a fraction of a millisecond after
 * capturing its own clock reading — so a strict sign check would fail the
 * documented `runAfter(0, …)` call at random. The delay is therefore clamped at
 * zero while it is still a finite number, which leaves the half that matters:
 * a value that is not a number at all.
 * @param timestampMs the absolute instant (epoch ms) the caller passed
 * @param nowMs the clock to measure it against — the wall clock in production, the harness's virtual clock in a test
 * @param surface what to name in the message — the call the instant was passed to (e.g. `"ctx.scheduler.runAt"`)
 */
const assertScheduleInstant = (timestampMs: number, nowMs: number, surface: string): void => {
    const delayMs = timestampMs - nowMs;

    assertScheduleDelay(Number.isFinite(delayMs) && delayMs < 0 ? 0 : delayMs, surface, "date");
};

export default assertScheduleInstant;
