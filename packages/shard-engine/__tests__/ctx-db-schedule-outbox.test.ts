import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import {
    dropScheduleOutbox,
    migrateScheduleOutbox,
    parkScheduleOutbox,
    probeScheduleOutbox,
    readScheduleOutbox,
    recordScheduleOutbox,
    requeueScheduleOutbox,
    trimScheduleOutbox,
} from "../src/ctx-db-schedule-outbox";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The operator's view of `__schedule_outbox`: the entries a shard holds because
 * the scheduler never accepted them, and the two ways out — retry one now, or
 * drop it. Runs on real SQLite so the ordering and the park/unpark round-trip
 * behave the way they will inside a Durable Object.
 */
describe("schedule outbox admin helpers", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let sql: SqlExec;

    const envelope = (target: unknown, options?: Record<string, unknown>): string => JSON.stringify({ args: {}, options, target, when: 5000 });

    beforeEach(() => {
        harness = createSqliteExec();
        sql = harness.sql;
        migrateScheduleOutbox(sql);
    });

    afterEach(() => {
        harness.close();
    });

    it("lists live entries before parked ones, with the target and policy read from the envelope", () => {
        expect.assertions(1);

        recordScheduleOutbox(sql, "parked", envelope({ __lunoraRef: "billing:charge" }), 100);
        parkScheduleOutbox(sql, "parked", 8, 150);
        recordScheduleOutbox(sql, "forever", envelope({ __lunoraRef: "billing:sync" }, { retry: { forever: true } }), 200);
        recordScheduleOutbox(sql, "workflow", envelope({ className: "OnboardingWorkflow", isLunoraWorkflow: true }), 300);

        expect(readScheduleOutbox(sql, 10).entries).toStrictEqual([
            { attempts: 0, createdAt: 200, forever: true, id: "forever", nextAttemptAt: 200, parked: false, target: "billing:sync", when: 5000 },
            { attempts: 0, createdAt: 300, forever: false, id: "workflow", nextAttemptAt: 300, parked: false, target: "OnboardingWorkflow", when: 5000 },
            { attempts: 8, createdAt: 100, forever: false, id: "parked", nextAttemptAt: 150, parked: true, target: "billing:charge", when: 5000 },
        ]);
    });

    it("still lists an entry whose envelope is unreadable, so it can be dropped", () => {
        expect.assertions(1);

        recordScheduleOutbox(sql, "broken", "{not json", 100);

        expect(readScheduleOutbox(sql, 10).entries).toStrictEqual([
            { attempts: 0, createdAt: 100, forever: false, id: "broken", nextAttemptAt: 100, parked: false, target: undefined, when: undefined },
        ]);
    });

    it("requeues a parked entry onto the first rung, due now", () => {
        expect.assertions(3);

        recordScheduleOutbox(sql, "job-1", envelope("billing:charge"), 100);
        parkScheduleOutbox(sql, "job-1", 8, 150);

        expect(requeueScheduleOutbox(sql, "job-1", 9000)).toBe(true);
        expect(readScheduleOutbox(sql, 10).entries[0]).toMatchObject({ attempts: 0, nextAttemptAt: 9000, parked: false });
        // Live again, so the poll tier sees it as due.
        expect(probeScheduleOutbox(sql).dueAt).toBe(9000);
    });

    it("drops an entry for good and reports whether one existed", () => {
        expect.assertions(3);

        recordScheduleOutbox(sql, "job-1", envelope("billing:charge"), 100);

        expect(dropScheduleOutbox(sql, "job-1")).toBe(true);
        expect(readScheduleOutbox(sql, 10).entries).toStrictEqual([]);
        expect(dropScheduleOutbox(sql, "job-1")).toBe(false);
    });

    it("pages through every entry, so parked ones stay reachable behind live ones", () => {
        expect.assertions(4);

        recordScheduleOutbox(sql, "parked", envelope("billing:charge"), 100);
        parkScheduleOutbox(sql, "parked", 8, 150);
        recordScheduleOutbox(sql, "live-1", envelope("billing:sync"), 200);
        recordScheduleOutbox(sql, "live-2", envelope("billing:sync"), 200);

        const first = readScheduleOutbox(sql, 2);
        const second = readScheduleOutbox(sql, 2, first.nextCursor);

        expect(first.entries.map((entry) => entry.id)).toStrictEqual(["live-1", "live-2"]);
        expect(first.nextCursor).toBeTypeOf("string");
        expect(second.entries.map((entry) => entry.id)).toStrictEqual(["parked"]);
        expect(second.nextCursor).toBeUndefined();
    });

    it("refuses a cursor it did not issue", () => {
        expect.assertions(1);

        expect(() => readScheduleOutbox(sql, 10, "page-2")).toThrow(/malformed cursor/u);
    });

    it("ages a parked entry from when it parked, not from when it was recorded", () => {
        expect.assertions(1);

        const week = 604_800_000;

        // Recorded long ago (a retry.forever entry, or one re-queued by hand), parked just now.
        recordScheduleOutbox(sql, "old", envelope("billing:charge"), 100);
        parkScheduleOutbox(sql, "old", 9, 10 * week);
        trimScheduleOutbox(sql, 10 * week - week);

        expect(readScheduleOutbox(sql, 10).entries.map((entry) => entry.id)).toStrictEqual(["old"]);
    });

    it("reports a requeue of an unknown id without writing anything", () => {
        expect.assertions(2);

        expect(requeueScheduleOutbox(sql, "missing", 9000)).toBe(false);
        expect(probeScheduleOutbox(sql).populated).toBe(false);
    });
});
