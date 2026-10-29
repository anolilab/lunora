import type { ShardSqlExec } from "@lunora/platform";
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, recordScheduleOutbox, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RearmWindow } from "../src/alarm-rearm-breaker";
import {
    admitRearm,
    ALARM_REARM_WINDOW_MS,
    alarmRearmLimitFrom,
    DEFAULT_ALARM_REARM_LIMIT,
    ensureRearmWindowTable,
    readRearmWindow,
    recoveryWakeAt,
    writeRearmWindow,
} from "../src/alarm-rearm-breaker";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The runaway breaker on the shard's poll alarm (alarm-rearm-breaker.ts), driven
 * through the real alarm path. The harness models the runtime: one alarm slot,
 * cleared when it is delivered and set by `setAlarm`, and a clock the test moves to
 * each delivery time. A refused re-arm must leave a recovery wake in that slot, so
 * the chain keeps going at one wake per window rather than stopping.
 */

const NOW = 1_700_000_000_000;
const LIMIT = DEFAULT_ALARM_REARM_LIMIT;
const WINDOW = ALARM_REARM_WINDOW_MS;

const schema: SchemaLike = { tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } } };

/** The shard-side view of the same SQLite handle, as the window helpers take it. */
const asShardSql = (sql: unknown): ShardSqlExec => sql as ShardSqlExec;

let harness: ReturnType<typeof createSqliteExec>;

/** The one alarm slot the platform holds for the shard, `undefined` when none is armed. */
let slot: number | undefined;

/** Every `setAlarm` the shard issued, in order. */
let armed: number[];

const makeState = (): ShardDOState => {
    // The platform's `getAlarm` is optional on the state type, so the storage is built apart and the
    // whole state asserted. The host reads `getAlarm` at runtime, exactly as it does on Cloudflare.
    const storage = {
        getAlarm: () => slot ?? null,
        setAlarm(scheduledTime: number | Date) {
            const at = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();

            slot = at;
            armed.push(at);

            return Promise.resolve();
        },
        sql: harness.sql as unknown as ShardDOState["storage"]["sql"],
    };

    return {
        acceptWebSocket() {
            /* no sockets in this test */
        },
        getWebSockets() {
            return [];
        },
        storage,
    };
};

/**
 * A shard whose one source is always due, the loop shape the breaker exists for.
 * The outbox scheduler is a recording fake, so the outbox test can see whether a
 * pending job reached it.
 */
class LoopShard extends ShardDO {
    public readonly attempts: { id: string | undefined; when: number }[] = [];

    /** When set, the next dispatch to the scheduler rejects instead of accepting. */
    public failNextDispatch = false;

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    // eslint-disable-next-line class-methods-use-this -- the source is always due, so every alarm tick re-arms
    protected override pollExternalSources(): Promise<number | undefined> {
        return Promise.resolve(Date.now());
    }

    protected override scheduleOutboxScheduler(): undefined {
        return {
            runAt: (when: number, _target: unknown, _args: unknown, options: { id?: string } | undefined) => {
                this.attempts.push({ id: options?.id, when });

                if (this.failNextDispatch) {
                    this.failNextDispatch = false;

                    return Promise.reject(new Error("scheduler unreachable"));
                }

                return Promise.resolve(options?.id ?? "job");
            },
        } as never;
    }
}

/** A healthy poll: its source reports a 2 s cadence, the steady-state workload the budget must never touch. */
class HealthyShard extends LoopShard {
    // eslint-disable-next-line class-methods-use-this -- a fixed 2 s cadence, the steady-state poll
    protected override pollExternalSources(): Promise<number | undefined> {
        return Promise.resolve(Date.now() + 2000);
    }
}

/**
 * The codegen shape: the constructor arms the poll on every instance, including the
 * one an alarm wakes after an eviction. Each `new` here is one such cold start.
 */
class ColdLoopShard extends LoopShard {
    /** Settles when the constructor's arm has finished, so a test can wait for it before the tick. */
    public readonly bootstrap: Promise<void>;

    public constructor(state: ShardDOState, env: Record<string, unknown>) {
        super(state, env);
        // Mirrors the codegen constructor, which fires this arm without awaiting it.
        // eslint-disable-next-line sonarjs/no-async-constructor -- the codegen constructor does exactly this
        this.bootstrap = this.scheduleSourcePoll();
    }
}

/** One eviction-driven wake: a new instance whose constructor arm settles before its alarm tick runs. */
const coldWake = async (env: Record<string, unknown> = {}): Promise<void> => {
    const shard = new ColdLoopShard(makeState(), env);

    await shard.bootstrap;
    await shard.alarm();
};

/**
 * A healthy 2 s poll whose I/O runs after the next-due is computed. The clock moves 300 ms
 * before the target is returned, so a check against the admit-time clock would see the
 * target 1 700 ms out and count a healthy re-arm.
 */
class IoHealthyShard extends LoopShard {
    // eslint-disable-next-line class-methods-use-this -- a fixed 2 s cadence, with I/O after the target is set
    protected override pollExternalSources(): Promise<number | undefined> {
        const nextDueAt = Date.now() + 2000;

        vi.setSystemTime(Date.now() + 300);

        return Promise.resolve(nextDueAt);
    }
}

/**
 * The generated source tier as it is written: the alarm reached the shard 5 ms late, the poll did
 * 300 ms of I/O, and the next-due is taken after the poll (`polledAt + everyMs`), not before it.
 */
class LatePollShard extends LoopShard {
    // eslint-disable-next-line class-methods-use-this -- a fixed 2 s cadence, with a late alarm and I/O before the next-due
    protected override pollExternalSources(): Promise<number | undefined> {
        vi.setSystemTime(Date.now() + 5 + 300);

        const polledAt = Date.now();

        return Promise.resolve(polledAt + 2000);
    }
}

/**
 * One eviction-driven wake: a new instance runs the cold-start arm, then its alarm tick. The arm is
 * the call the codegen constructor makes, issued straight after construction, so nothing runs between.
 */
const coldWakeOf = async (shard: LoopShard): Promise<void> => {
    await (shard as unknown as { scheduleSourcePoll: () => Promise<void> }).scheduleSourcePoll();
    await shard.alarm();
};

const newShard = (env: Record<string, unknown> = {}): LoopShard => new LoopShard(makeState(), env);

/** Fill the durable window to the limit, as if a burst had just spent the budget. */
const fillWindow = (windowStart: number): void => {
    ensureRearmWindowTable(asShardSql(harness.sql));
    writeRearmWindow(asShardSql(harness.sql), { currentCount: LIMIT, previousCount: 0, windowStart });
};

/**
 * Deliver the pending alarm the way the runtime does: clear the slot, move the clock
 * to the delivery time, then run the handler. Returns the delivery time.
 */
const deliver = async (run: () => Promise<unknown>, at: number): Promise<number> => {
    vi.setSystemTime(at);
    slot = undefined;

    await run();

    return at;
};

/**
 * Keep delivering the pending alarm until the slot is empty, past `horizon`, or
 * `maxWakes` deliveries have run. Returns the delivery times, in order.
 */
const runChain = async (horizon: number, maxWakes: number, run: () => Promise<unknown>): Promise<number[]> => {
    const wakes: number[] = [];

    while (slot !== undefined && slot <= horizon && wakes.length < maxWakes) {
        // eslint-disable-next-line no-await-in-loop -- each wake must finish before the next, as the runtime serializes alarms
        wakes.push(await deliver(run, slot));
    }

    return wakes;
};

/** Events per window, for windows `0..count-1` from `NOW`. Pass the `setAlarm` history or the alarm deliveries. */
const wakesPerWindow = (wakes: number[], count: number): number[] => {
    const buckets = Array.from<number>({ length: count }).fill(0);

    for (const at of wakes) {
        const index = Math.floor((at - NOW) / WINDOW);

        if (index >= 0 && index < count) {
            const current: number = buckets[index] ?? 0;

            buckets[index] = current + 1;
        }
    }

    return buckets;
};

describe("alarm re-arm breaker", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        armed = [];
        slot = undefined;
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
        harness.close();
        vi.restoreAllMocks();
    });

    describe("sliding-window counter", () => {
        it("admits up to the limit within one window and refuses the next re-arm without counting it", () => {
            expect.assertions(3);

            let window: RearmWindow | undefined;
            const admitted: boolean[] = [];

            for (let index = 0; index < 5; index += 1) {
                const result = admitRearm(window, NOW, 3);

                admitted.push(result.admitted);
                window = result.window;
            }

            expect(admitted).toStrictEqual([true, true, true, false, false]);
            expect(window?.currentCount).toBe(3);
            expect(window?.windowStart).toBe(NOW);
        });

        it("weighs the previous window into the estimate, so a boundary burst cannot double the budget", () => {
            expect.assertions(3);

            const filled: RearmWindow = { currentCount: 10, previousCount: 0, windowStart: NOW };

            // At the exact boundary the previous window still weighs fully: 10 >= 10, refused.
            expect(admitRearm(filled, NOW + WINDOW, 10).admitted).toBe(false);

            // Half way into the next window the previous count weighs half: 5 < 10, admitted.
            expect(admitRearm(filled, NOW + WINDOW + WINDOW / 2, 10).admitted).toBe(true);

            // Once the previous window has fully aged out, the budget is whole again.
            expect(admitRearm(filled, NOW + 2 * WINDOW, 10).admitted).toBe(true);
        });

        it("drops the carried count after two whole windows of silence", () => {
            expect.assertions(1);

            const window: RearmWindow = { currentCount: 50, previousCount: 50, windowStart: NOW };

            expect(admitRearm(window, NOW + 2 * WINDOW + 1, 10).window.previousCount).toBe(0);
        });

        it("treats a clock that steps backwards as the window's start instead of inflating the estimate", () => {
            expect.assertions(1);

            const window: RearmWindow = { currentCount: 9, previousCount: 0, windowStart: NOW };

            expect(admitRearm(window, NOW - 5000, 10).admitted).toBe(true);
        });
    });

    describe("limit parsing", () => {
        it("uses the default when unset or malformed, and disables on an explicit 0", () => {
            expect.assertions(7);

            expect(alarmRearmLimitFrom({})).toBe(DEFAULT_ALARM_REARM_LIMIT);
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: "250" })).toBe(250);
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: 250 })).toBe(250);
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: "1.5" })).toBe(DEFAULT_ALARM_REARM_LIMIT);
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: "250ms" })).toBe(DEFAULT_ALARM_REARM_LIMIT);
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: "0" })).toBeUndefined();
            expect(alarmRearmLimitFrom({ LUNORA_ALARM_REARM_LIMIT: 0 })).toBeUndefined();
        });
    });

    describe("durable window", () => {
        it("round-trips the window through the shard's own SQL", () => {
            expect.assertions(2);

            ensureRearmWindowTable(asShardSql(harness.sql));

            expect(readRearmWindow(asShardSql(harness.sql))).toBeUndefined();

            writeRearmWindow(asShardSql(harness.sql), { currentCount: 7, previousCount: 2, windowStart: NOW });

            expect(readRearmWindow(asShardSql(harness.sql))).toStrictEqual({ currentCount: 7, previousCount: 2, windowStart: NOW });
        });
    });

    describe("a refusal leaves a recovery wake one window out", () => {
        it("arms exactly one recovery wake, at one window plus one millisecond, when the budget is spent", async () => {
            expect.assertions(3);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);

            await deliver(() => newShard().alarm(), NOW);

            // One refused tick, one recovery arm. Nothing else is armed.
            expect(armed).toStrictEqual([recoveryWakeAt(NOW)]);
            expect(slot).toBe(NOW + WINDOW + 1);
            expect(recoveryWakeAt(NOW)).toBe(NOW + WINDOW + 1);
        });

        it("keeps an earlier pending alarm rather than pushing it later on a refused cold start", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);
            vi.setSystemTime(NOW);

            // An earlier wake is already pending (say, a healthy 2 s poll armed before the trip).
            slot = NOW + 2000;

            const shard = new ColdLoopShard(makeState(), {});

            await shard.bootstrap;

            // The refused cold start must not replace the earlier wake with a later one.
            expect(slot).toBe(NOW + 2000);
            expect(armed).toStrictEqual([]);
        });

        it("does not spend the budget on a bootstrap call that would arm nothing", async () => {
            expect.assertions(3);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            vi.setSystemTime(NOW);

            // One long-lived instance, as after a sourced write: the alarm is armed once and every
            // later call finds it pending. None of those calls re-arms anything.
            const shard = new ColdLoopShard(makeState(), {});

            await shard.bootstrap;

            for (let call = 0; call < DEFAULT_ALARM_REARM_LIMIT * 3; call += 1) {
                // eslint-disable-next-line no-await-in-loop -- each call settles before the next, as a request handler does
                await (shard as unknown as { scheduleSourcePoll: () => Promise<void> }).scheduleSourcePoll();
            }

            expect(armed).toHaveLength(1);

            // The cold start is floor-paced, so no arm is recorded and the budget is untouched.
            expect(readRearmWindow(asShardSql(harness.sql))?.currentCount ?? 0).toBe(0);
            expect(error).not.toHaveBeenCalled();
        });

        it("arms the recovery even when the slot still reports the alarm that just fired", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);
            vi.setSystemTime(NOW);

            // The platform can still report the alarm that is being handled, which is in the past.
            // Treating it as pending would skip the recovery and leave the shard idle for good.
            slot = NOW;

            await newShard().alarm();

            expect(slot).toBe(recoveryWakeAt(NOW));
            expect(armed).toStrictEqual([recoveryWakeAt(NOW)]);
        });
    });

    describe("the loop through the real alarm path", () => {
        it("a quiet shard resumes polling one window after the trip, at its normal cadence", async () => {
            expect.assertions(3);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);

            const shard = new HealthyShard(makeState(), {});

            await deliver(() => shard.alarm(), NOW);

            const wakes = await runChain(NOW + 3 * WINDOW, 500, () => shard.alarm());

            // The first wake after the trip is the recovery wake, one window and a millisecond out.
            expect(wakes[0]).toBe(NOW + WINDOW + 1);

            // From there it polls at the healthy 2 s cadence: the window has drained, so every re-arm is admitted.
            const gaps = wakes.slice(1, 10).map((at, index) => at - (wakes[index] ?? at));

            expect(gaps).toStrictEqual(Array.from({ length: 9 }).fill(2000));
            // Every healthy tick armed exactly one re-arm after the recovery wake.
            expect(armed.length).toBeGreaterThanOrEqual(50);
        });

        it("a still-looping shard is throttled, bursting to about the limit, never stopped", async () => {
            expect.assertions(3);

            vi.spyOn(console, "error").mockImplementation(() => undefined);

            const shard = newShard();

            await deliver(() => shard.alarm(), NOW);
            await runChain(NOW + 5 * WINDOW, 20_000, () => shard.alarm());

            const perWindow = wakesPerWindow(armed, 5);

            // Never stopped: every window of the run admits at least one re-arm.
            expect(perWindow.every((count) => count >= 1)).toBe(true);
            // Throttled: no window admits much more than the limit (the sliding estimate allows a small overshoot at the boundary).
            expect(Math.max(...perWindow)).toBeLessThanOrEqual(LIMIT + LIMIT / 10);
            // And the total stays within the budget for the run's span, plus the first window's own allowance.
            expect(armed.length).toBeLessThanOrEqual(LIMIT * 6);
        });

        it("a still-looping eviction-driven loop is throttled too: a cold start while tripped does not re-arm faster", async () => {
            expect.assertions(4);

            vi.spyOn(console, "error").mockImplementation(() => undefined);

            // Every wake is a new instance, so only the durable budget can slow the loop. Each cold
            // start also calls setAlarm, a floor arm that the tick then replaces, so the count is of
            // deliveries: the wakes the runtime actually runs.
            const wakes = [await deliver(() => coldWake(), NOW), ...(await runChain(NOW + 5 * WINDOW, 20_000, () => coldWake()))];

            const perWindow = wakesPerWindow(wakes, 5);

            expect(perWindow.every((count) => count >= 1)).toBe(true);
            expect(Math.max(...perWindow)).toBeLessThanOrEqual(LIMIT + LIMIT / 10);
            // Quieter windows between the bursts, as the docs promise. A tripped cold start that re-armed
            // at the floor would keep every window at the limit instead.
            expect(perWindow.slice(1).some((count) => count <= LIMIT / 10)).toBe(true);
            expect(wakes.length).toBeLessThanOrEqual(LIMIT * 6);
        });

        it("never refuses a re-arm when disabled with LUNORA_ALARM_REARM_LIMIT=0", async () => {
            expect.assertions(1);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            const shard = newShard({ LUNORA_ALARM_REARM_LIMIT: "0" });

            await deliver(() => shard.alarm(), NOW);
            await runChain(NOW + 60 * 60 * 1000, 999, () => shard.alarm());

            expect(armed).toHaveLength(1000);
        });

        it("logs about one trip per window, not one per refused re-arm", async () => {
            expect.assertions(2);

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const shard = newShard();

            await deliver(() => shard.alarm(), NOW);
            await runChain(NOW + 5 * WINDOW, 20_000, () => shard.alarm());

            const trips = error.mock.calls.filter((call) => String(call[0]).includes("alarm re-arm breaker tripped"));

            // The budget is spent in bursts, so a refusal lands about once per window; the recovery wake is what
            // brings the next one. A line per refused re-arm would be hundreds across this run.
            expect(trips.length).toBeGreaterThanOrEqual(1);
            expect(trips.length).toBeLessThanOrEqual(6);
        });
    });

    describe("what the breaker never touches", () => {
        it("keeps a schedule-outbox job retrying while the breaker is tripped", async () => {
            expect.assertions(3);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);

            // A user job the scheduler has not accepted: its custody is the outbox row.
            recordScheduleOutbox(harness.sql, "job-after-trip", JSON.stringify({ args: {}, options: undefined, target: "jobs:run", when: NOW + 60_000 }), NOW);

            const shard = newShard();

            // The first dispatch fails, so the entry backs off and stays in custody.
            shard.failNextDispatch = true;
            await deliver(() => shard.alarm(), NOW);

            // The dispatch was attempted, and the outbox's pending retry re-armed the alarm
            // even though the budget is spent: refusing it would strand the job.
            expect(shard.attempts.map((attempt) => attempt.id)).toStrictEqual(["job-after-trip"]);
            expect(armed.length).toBeGreaterThan(0);

            // Past the first backoff step (15 s) the retry lands, so custody ends and the job is accepted once.
            await deliver(() => shard.alarm(), NOW + 16_000);

            expect(shard.attempts.filter((attempt) => attempt.id === "job-after-trip")).toHaveLength(2);
        });

        it("commits an ordinary write while the breaker is tripped", async () => {
            expect.assertions(2);

            vi.spyOn(console, "error").mockImplementation(() => undefined);
            fillWindow(NOW);

            await deliver(() => newShard().alarm(), NOW);

            // The breaker is on the alarm path only, so a write goes straight through.
            const writer = createShardCtxDb({ clock: () => NOW, schema, sql: harness.sql });
            await writer.insert("notes", { _id: "n1", body: "written while tripped" }, { allowExplicitId: true });

            const row = await writer.get("notes", "n1");

            expect(row?.["body"]).toBe("written while tripped");
            expect(slot).toBe(recoveryWakeAt(NOW));
        });
    });

    describe("what a healthy re-arm costs in window writes", () => {
        it.each([
            ["the next-due is computed before the I/O", () => coldWakeOf(new IoHealthyShard(makeState(), {}))],
            ["the alarm is late and the next-due is computed after the poll", () => coldWakeOf(new LatePollShard(makeState(), {}))],
        ])("writes no window row for a 2 s poll, where %s, even when every wake is a fresh instance", async (_case, wake) => {
            expect.assertions(4);

            // Count the window's statements on the same handle the shard drives.
            const counts = { ddl: 0, read: 0, write: 0 };
            const sqlExec = harness.sql as unknown as { exec: (query: string, ...bindings: unknown[]) => unknown };
            const original = sqlExec.exec.bind(sqlExec);

            sqlExec.exec = (query: string, ...bindings: unknown[]) => {
                if (query.startsWith('CREATE TABLE IF NOT EXISTS "__lunora_alarm_rearm_window"')) {
                    counts.ddl += 1;
                } else if (query.startsWith("SELECT window_start")) {
                    counts.read += 1;
                } else if (query.startsWith('INSERT INTO "__lunora_alarm_rearm_window"')) {
                    counts.write += 1;
                }

                return original(query, ...bindings);
            };

            // Each wake is a new instance: an eviction between 2 s polls, the case that would otherwise write
            // per wake. The clock moves during each poll, so the pacing has to hold on that clock.
            const wakes = [await deliver(() => wake(), NOW), ...(await runChain(NOW + 60_000, 30, () => wake()))];

            expect(wakes.length).toBeGreaterThan(20);
            // A healthy poll and its cold starts read the window and write nothing to it.
            expect(counts.write).toBe(0);
            expect(counts.read).toBeGreaterThan(wakes.length);

            const [rows] = harness.sql.exec<{ n: number }>('SELECT count(*) AS n FROM "__lunora_alarm_rearm_window"').toArray();

            expect(rows?.n).toBe(0);
        });
    });
});
