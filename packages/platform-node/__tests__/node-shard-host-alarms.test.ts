import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";

/**
 * Alarm delivery semantics this host owns itself, because a Node process has no
 * runtime to lean on: redelivery of a throwing handler, and the durable row and
 * the in-process timer agreeing after a transaction settles.
 *
 * Both were places the host quietly diverged from workerd. A throwing `alarm()`
 * had its row deleted before delivery and its rejection swallowed, so the
 * wakeup was gone for good — while workerd retries it. And `alarms.set` inside a
 * transaction armed the timer immediately while the row rolled back with the
 * transaction, leaving an alarm that fires once in this process and never again.
 */
describe("createNodeShardHost alarms", () => {
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    const alarmRowCount = (database: Database.Database): number =>
        database.prepare<[], { n: number }>("SELECT count(*) AS n FROM _lunora_alarm").get()?.n ?? -1;

    it("re-delivers an alarm whose handler threw, and stops once it succeeds", async () => {
        expect.assertions(3);

        let attempts = 0;
        const { database, dispose, host } = createNodeShardHost({
            onAlarm: () => {
                attempts += 1;

                if (attempts === 1) {
                    throw new Error("handler failed");
                }
            },
        });

        try {
            await host.alarms.set(Date.now() + 5);
            await sleep(200);

            // Retried exactly once: the second delivery succeeded, so nothing
            // re-armed after it. A host that kept retrying a handler that
            // already worked would show more.
            expect(attempts).toBe(2);
            expect(host.alarms.get()).toBeNull();
            expect(alarmRowCount(database)).toBe(0);
        } finally {
            dispose();
        }
    });

    it("keeps the durable row armed between redeliveries, so a restart still owes the wakeup", async () => {
        expect.assertions(2);

        let attempts = 0;
        const { database, dispose, host } = createNodeShardHost({
            onAlarm: () => {
                attempts += 1;

                throw new Error("handler failed");
            },
        });

        try {
            await host.alarms.set(Date.now() + 5);
            await sleep(60);

            expect(attempts).toBe(1);

            // The row the pre-fix host deleted before delivery and never wrote
            // back. Without it a restart between attempts loses the alarm.
            expect(alarmRowCount(database)).toBe(1);
        } finally {
            dispose();
        }
    });

    it("drops an alarm set inside a transaction that rolled back", async () => {
        expect.assertions(5);

        let fired = 0;
        const { database, dispose, host } = createNodeShardHost({
            onAlarm: () => {
                fired += 1;
            },
        });

        try {
            await expect(
                host.transaction(async () => {
                    await host.alarms.set(Date.now() + 20);

                    // Reads inside the transaction observe its own writes.
                    expect(host.alarms.get()).not.toBeNull();

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            expect(host.alarms.get()).toBeNull();
            expect(alarmRowCount(database)).toBe(0);

            await sleep(60);

            expect(fired).toBe(0);
        } finally {
            dispose();
        }
    });

    it("arms an alarm set inside a transaction that committed", async () => {
        expect.assertions(2);

        let fired = 0;
        const { dispose, host } = createNodeShardHost({
            onAlarm: () => {
                fired += 1;
            },
        });

        try {
            await host.transaction(async () => {
                await host.alarms.set(Date.now() + 5);
            });

            expect(host.alarms.get()).not.toBeNull();

            await sleep(60);

            expect(fired).toBe(1);
        } finally {
            dispose();
        }
    });

    it("keeps an alarm a transaction rescheduled while the previous timer fired", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const workdir = mkdtempSync(join(tmpdir(), "lunora-platform-node-alarm-"));
        const path = join(workdir, "shard.sqlite");

        try {
            const first = createNodeShardHost({ path });
            const t1 = Date.now() + 10;
            const t2 = Date.now() + 10_000;

            try {
                await first.host.alarms.set(t1);
                await first.host.transaction(async () => {
                    await first.host.alarms.set(t2);
                    // T1's timer is still armed (the reschedule defers to commit) and fires now.
                    await vi.advanceTimersByTimeAsync(50);
                });

                const row = first.database.prepare<[], { scheduled_for: number }>("SELECT scheduled_for FROM _lunora_alarm").get();

                expect(row?.scheduled_for).toBe(t2);
                expect(first.host.alarms.get()).toBe(t2);
            } finally {
                first.dispose();
            }

            // A restart over the same file re-arms the rescheduled alarm.
            const second = createNodeShardHost({ path });

            try {
                expect(second.host.alarms.get()).toBe(t2);
            } finally {
                second.dispose();
            }
        } finally {
            vi.useRealTimers();
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("re-arms an alarm a rolled-back transaction restored after its timer fired mid-transaction", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        let fired = 0;
        const { dispose, host } = createNodeShardHost({
            onAlarm: () => {
                fired += 1;
            },
        });

        try {
            const t1 = Date.now() + 10;

            await host.alarms.set(t1);

            await expect(
                host.transaction(async () => {
                    await host.alarms.delete();
                    // The timer fires while the delete is uncommitted, so it sees no row.
                    await vi.advanceTimersByTimeAsync(50);

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            expect(host.alarms.get()).toBe(t1);

            await vi.advanceTimersByTimeAsync(0);

            expect(fired).toBe(1);
        } finally {
            dispose();
            vi.useRealTimers();
        }
    });

    it("delivers an alarm once when it comes due inside another task's transaction that rolls back", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        let fired = 0;
        const { database, dispose, host } = createNodeShardHost({
            onAlarm: () => {
                fired += 1;
            },
        });

        try {
            await host.alarms.set(Date.now() + 10);

            await expect(
                host.transaction(async () => {
                    // The transaction never touches the alarm; the timer just comes due while it is open.
                    await vi.advanceTimersByTimeAsync(50);

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            await vi.advanceTimersByTimeAsync(50);

            expect(fired).toBe(1);
            expect(host.alarms.get()).toBeNull();
            expect(alarmRowCount(database)).toBe(0);
        } finally {
            dispose();
            vi.useRealTimers();
        }
    });

    it("does not let a failed alarm's retry overwrite a newer alarm another host scheduled", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-"));
        const path = join(directory, "shard.sqlite3");
        const t2 = Date.now() + 60_000;
        let second: ReturnType<typeof createNodeShardHost> | undefined;
        const first = createNodeShardHost({
            onAlarm: async () => {
                // Another process schedules a newer alarm while this delivery is failing.
                await second?.host.alarms.set(t2);

                throw new Error("handler failed");
            },
            path,
        });

        try {
            await first.host.alarms.set(Date.now() + 10);

            second = createNodeShardHost({ path });

            try {
                await vi.advanceTimersByTimeAsync(50);

                const row = first.database.prepare<[], { scheduled_for: number }>("SELECT scheduled_for FROM _lunora_alarm").get();

                expect(row?.scheduled_for).toBe(t2);
            } finally {
                second.dispose();
                second.database.close();
            }
        } finally {
            first.dispose();
            first.database.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("retries the claim of an alarm another process holds the write lock over", async () => {
        expect.assertions(5);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-"));
        const path = join(directory, "shard.sqlite3");
        let delivered = 0;
        const { database, dispose, host } = createNodeShardHost({
            onAlarm: () => {
                delivered += 1;
            },
            path,
        });
        // Another process over the same file, holding its write lock.
        const other = new Database(path);

        try {
            // Fail the claim at once instead of blocking the event loop for the default busy timeout.
            database.pragma("busy_timeout = 0");
            await host.alarms.set(Date.now() + 10);

            other.exec("BEGIN IMMEDIATE");
            // The claim throws SQLITE_BUSY inside the timer; it must not escape it.
            await vi.advanceTimersByTimeAsync(50);

            expect(delivered).toBe(0);
            expect(alarmRowCount(database)).toBe(1);

            other.exec("ROLLBACK");
            await vi.advanceTimersByTimeAsync(1000);

            expect(delivered).toBe(1);
            expect(host.alarms.get()).toBeNull();
            expect(alarmRowCount(database)).toBe(0);
        } finally {
            other.close();
            dispose();
            database.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("delivers an alarm once when two hosts share one database file", async () => {
        expect.assertions(1);

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-"));
        const path = join(directory, "shard.sqlite3");
        let delivered = 0;
        const onAlarm = (): void => {
            delivered += 1;
        };
        const first = createNodeShardHost({ onAlarm, path });

        try {
            await first.host.alarms.set(Date.now() + 50);

            // Constructed over the same file, so it restores and arms the same row.
            const second = createNodeShardHost({ onAlarm, path });

            try {
                await sleep(300);

                expect(delivered).toBe(1);
            } finally {
                second.dispose();
                second.database.close();
            }
        } finally {
            first.dispose();
            first.database.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });
});
