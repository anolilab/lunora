import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

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
});
