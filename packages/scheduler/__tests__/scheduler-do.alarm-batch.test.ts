import { afterEach, describe, expect, it } from "vitest";

import { SchedulerDO } from "../src/scheduler-do";
import type { ScheduleRecord } from "../src/types";
import { createAlarmHarness } from "./alarm-harness";

class TestScheduler extends SchedulerDO {
    public dispatched: ScheduleRecord[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record);

        return true;
    }
}

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("schedulerDO alarm — concurrent header reads", () => {
    let dispose: (() => void) | undefined;

    afterEach(() => {
        dispose?.();
        dispose = undefined;
    });

    const setup = (now: number) => {
        const created = createAlarmHarness((state, env) => new TestScheduler(state, env), { now });

        dispose = created.dispose;

        return created;
    };

    // Wrap the fake's `get` AFTER scheduling so only the alarm tick is measured.
    const trackHeaderGets = (storage: { get: (key: string) => Promise<unknown> }) => {
        const stats = { headerGets: 0, inFlight: 0, maxInFlight: 0 };
        const inner = storage.get.bind(storage);

        Object.assign(storage, {
            get: async (key: string) => {
                if (!key.startsWith("id:")) {
                    return inner(key);
                }

                stats.headerGets += 1;
                stats.inFlight += 1;
                stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);

                try {
                    return await inner(key);
                } finally {
                    stats.inFlight -= 1;
                }
            },
        });

        return stats;
    };

    it("reads all 50 due headers concurrently, not one round trip at a time", async () => {
        expect.assertions(3);

        const now = 1_700_000_000_000;
        const { scheduler, state, fastForwardToAlarm } = setup(now);

        for (let index = 0; index < 50; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each /schedule mutates shared storage
            await scheduler.fetch(
                post("/schedule", { args: {}, functionPath: `jobs.n${String(index)}`, id: `job-${String(index)}`, scheduledFor: now + 1000 }),
            );
        }

        const stats = trackHeaderGets(state.storage);

        await fastForwardToAlarm();

        expect(stats.maxInFlight).toBe(50);
        // dispatch re-reads each header once more, so the tick totals 2x; concurrency is the contract.
        expect(stats.headerGets).toBeGreaterThanOrEqual(50);
        expect(scheduler.dispatched).toHaveLength(50);
    });

    it("deletes an index entry whose header is missing and still dispatches the rest", async () => {
        expect.assertions(4);

        const now = 1_700_000_000_000;
        const { scheduler, state, fastForwardToAlarm } = setup(now);

        for (const id of ["a", "b", "c"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential scheduling keeps the fixture deterministic
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: `jobs.${id}`, id, scheduledFor: now + 1000 }));
        }

        const orphanKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:") && state.storageMap.get(key) === "b");

        expect(orphanKey).toBeDefined();

        state.storageMap.delete("id:b");

        await fastForwardToAlarm();

        expect(state.storageMap.has(orphanKey as string)).toBe(false);
        expect(scheduler.dispatched.map((record) => record.functionPath ?? "").toSorted((left, right) => left.localeCompare(right))).toEqual([
            "jobs.a",
            "jobs.c",
        ]);
        expect(scheduler.dispatched).toHaveLength(2);
    });

    it("does not read any header when nothing is due", async () => {
        expect.assertions(1);

        const now = 1_700_000_000_000;
        const { scheduler, state, advanceTo } = setup(now);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.later", id: "later", scheduledFor: now + 60_000 }));

        const stats = trackHeaderGets(state.storage);

        advanceTo(now + 1000);
        await scheduler.alarm();

        expect(stats.headerGets).toBe(0);
    });
});
