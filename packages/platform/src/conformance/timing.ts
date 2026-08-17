/**
 * The two waits every `ConformanceHost` needs and none of them needs to write.
 *
 * `awaitAlarmFired` and `awaitJobDispatched` are host hooks, but their bodies
 * are not host-specific: both are "wait slightly past a timestamp, then look".
 * Three hosts had byte-identical copies of them — the reference host, the Node
 * host and the Rivet host — including the comment explaining the strategy, so
 * the strategy lives here and a host supplies only what it genuinely owns (its
 * scheduler, and the set of ids its `onDispatch` recorded).
 */

import type { SchedulerHost } from "../scheduler-host";

/**
 * Margin added past a target timestamp before observing the transition.
 *
 * Alarms and jobs fire from real timers in every host that implements these
 * hooks, so an exact-target wait races the timer it is waiting for.
 */
const SETTLE_MARGIN_MS = 30;

/**
 * Wait until `target` has passed, plus a small settle margin.
 * @param target Epoch-ms timestamp to wait past.
 */
const waitPastTarget = async (target: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, target - Date.now()) + SETTLE_MARGIN_MS);
    });
};

/**
 * Wait for a job to be delivered, then report whether it was.
 *
 * Reads the job's own `scheduledFor` while it is still pending and waits past
 * it. A job already absent from `list()` either fired or never existed, and
 * `dispatched` — the ids the host's `onDispatch` actually saw — is what tells
 * those two apart. That distinction is the point of the TCK's dispatch leg: a
 * host can expire a timer without ever invoking its delivery path.
 * @param scheduler The host's scheduler.
 * @param dispatched Ids the host's `onDispatch` recorded.
 * @param id The job to wait for.
 * @returns whether the job was dispatched.
 */
const pollJobDispatched = async (scheduler: SchedulerHost, dispatched: ReadonlySet<string>, id: string): Promise<boolean> => {
    const listed = await scheduler.list?.();
    const pending = listed?.find((entry) => entry.id === id);

    if (pending !== undefined) {
        await waitPastTarget(pending.scheduledFor);
    }

    return dispatched.has(id);
};

export { pollJobDispatched, waitPastTarget };
