import { vi } from "vitest";

import type { SchedulerDO, SchedulerDOState, SchedulerEnv } from "../src/scheduler-do";
import { createFakeState } from "./fake-state";

type FakeState = ReturnType<typeof createFakeState>;

/**
 * Factory that builds the DO under test from the harness-provided fake state +
 * env. Mirrors the `new SchedulerDO(state, env)` constructor so tests can pass
 * a `TestScheduler`/`FailingScheduler` subclass and still get the tracked
 * storage stub.
 */
type SchedulerFactory<T extends SchedulerDO> = (state: SchedulerDOState, env: SchedulerEnv) => T;

export interface AlarmHarness<T extends SchedulerDO> {
    /** Advance the controlled clock to `timestamp` (no-op if already past it). */
    advanceTo: (timestamp: number) => void;
    /** The currently-armed alarm timestamp (last `setAlarm`, or `null` if cleared). */
    currentAlarm: () => number | null;
    /** Restore real timers. Call in `afterEach`. */
    dispose: () => void;

    /**
     * Drive the real Cloudflare alarm contract: advance the clock to the
     * earliest armed alarm, clear it the way the runtime does *before* invoking
     * the handler, then call the DO's `alarm()`. Returns the fire metadata so a
     * test can assert "the right alarm time was set, advancing time fires it,
     * re-scheduling sets the next alarm". Throws if no alarm is armed — a test
     * that expects a fire must first observe an armed alarm.
     */
    fastForwardToAlarm: () => Promise<{ alarmBefore: number; firedAt: number }>;
    /** The harness's controlled wall clock (what `Date.now()` returns). */
    now: () => number;
    /** The DO instance under test, constructed over the tracked fake state. */
    scheduler: T;

    /**
     * Every `setAlarm(timestamp)` the DO has issued, in call order. Lets a test
     * assert the *exact* armed time the runtime would honour — the half of the
     * schedule→fire contract that calling `alarm()` directly never checks. A
     * `deleteAlarm()` records `null`.
     */
    readonly setAlarmCalls: (number | null)[];
    /** The underlying fake state (storage map + alarm accessor). */
    state: FakeState;
}

/**
 * Build a fake-clock alarm harness around a {@link SchedulerDO}.
 *
 * Unlike calling `scheduler.alarm()` directly, this exercises the real
 * `setAlarm(timestamp)` → clock-reaches-timestamp → `onAlarm()` contract that
 * the Workers runtime implements:
 *
 * - The storage stub's `setAlarm`/`deleteAlarm` calls are recorded so a test
 * can assert the DO armed the alarm for the correct earliest-pending time.
 * - `fastForwardToAlarm()` advances a controlled clock (via Vitest fake timers,
 * so the DO's own `Date.now()` moves with it) up to that armed time, clears the
 * alarm exactly as the runtime does before delivery, and only then invokes
 * `alarm()`. A record is therefore only "due" once time has actually advanced
 * to its scheduled instant — re-scheduling, backoff, and cron-style re-arming
 * all flow through the same wiring the runtime uses.
 */
export const createAlarmHarness = <T extends SchedulerDO>(
    factory: SchedulerFactory<T>,
    options: { env?: SchedulerEnv; now?: number } = {},
): AlarmHarness<T> => {
    const startNow = options.now ?? Date.now();

    // Fake timers make the DO's internal `Date.now()` track the harness clock,
    // so a record only becomes "due" once we advance time to its scheduledFor.
    vi.useFakeTimers();
    vi.setSystemTime(startNow);

    const base = createFakeState();
    const setAlarmCalls: (number | null)[] = [];

    // Wrap setAlarm/deleteAlarm so every arming the DO performs is recorded in
    // call order — the assertion surface the direct-`alarm()` tests lacked.
    const innerSetAlarm = base.storage.setAlarm.bind(base.storage);
    const innerDeleteAlarm = base.storage.deleteAlarm.bind(base.storage);

    base.storage.setAlarm = async (time: number | Date): Promise<void> => {
        setAlarmCalls.push(time instanceof Date ? time.getTime() : time);
        await innerSetAlarm(time);
    };
    base.storage.deleteAlarm = async (): Promise<void> => {
        setAlarmCalls.push(null);
        await innerDeleteAlarm();
    };

    const env = options.env ?? { LUNORA_ORIGIN_URL: "https://app.test" };
    const scheduler = factory(base, env);

    return {
        advanceTo: (timestamp: number): void => {
            if (timestamp > Date.now()) {
                vi.setSystemTime(timestamp);
            }
        },
        currentAlarm: (): number | null => base.alarm,
        dispose: (): void => {
            vi.useRealTimers();
        },
        fastForwardToAlarm: async (): Promise<{ alarmBefore: number; firedAt: number }> => {
            const alarmBefore = base.alarm;

            if (alarmBefore === null) {
                throw new Error("createAlarmHarness: no alarm is armed — schedule a job before fastForwardToAlarm()");
            }

            // The runtime fires the alarm once the wall clock reaches the armed
            // time; advance there if we are not already past it.
            if (alarmBefore > Date.now()) {
                vi.setSystemTime(alarmBefore);
            }

            // Workers clears the pending alarm before delivering `alarm()`; the
            // handler re-arms via setAlarm() if more work remains. Clear without
            // recording it as a DO-issued call so the history stays clean.
            await innerDeleteAlarm();

            await scheduler.alarm();

            return { alarmBefore, firedAt: Date.now() };
        },
        now: (): number => Date.now(),
        scheduler,
        setAlarmCalls,
        state: base,
    };
};
