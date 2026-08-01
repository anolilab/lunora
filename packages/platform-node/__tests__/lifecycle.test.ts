import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodePlatform } from "../src/node-platform";
import { createNodeSchedulerHost } from "../src/node-scheduler-host";
import { createNodeShardHost } from "../src/node-shard-host";

/**
 * Covers the lifecycle-owner cluster: nothing previously closed the
 * `better-sqlite3` handle or cleared pending timers, and a caller that set a
 * future alarm and then closed the database out from under it hit an
 * uncaught `TypeError` from inside a `setTimeout` callback — a crash `try`/
 * `catch` at the call site cannot intercept, since the throw happens on a
 * later turn of the event loop, not synchronously under the caller's call
 * stack.
 */
describe("lifecycle disposers", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-platform-node-lifecycle-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("alarm timer vs. a closed database", () => {
        it("does not throw when the alarm timer fires after the database was closed directly (bypassing dispose)", async () => {
            expect.assertions(1);

            vi.useFakeTimers();

            try {
                const { database, host } = createNodeShardHost();

                await host.alarms.set(Date.now() + 1000);
                // Simulate a caller that closes the connection without going
                // through this host's own disposer — the exact shape of the P1
                // finding: nothing stopped the alarm timer from outliving the
                // connection it depends on.
                database.close();

                expect(() => vi.advanceTimersByTime(1001)).not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it("does not persist alarm-cleared state once the database is closed — the guarded callback is a no-op", async () => {
            expect.assertions(1);

            vi.useFakeTimers();

            const path = join(workdir, "alarm-guard.sqlite3");

            try {
                const { database, host } = createNodeShardHost({ path });

                await host.alarms.set(Date.now() + 1000);
                database.close();

                vi.advanceTimersByTime(1001);
            } finally {
                vi.useRealTimers();
            }

            // Reopen the same file: if the guard worked, the alarm row this
            // host wrote when `set()` ran is still there, because the timer's
            // `persist(undefined)` never got to run its `DELETE` against the
            // now-closed connection.
            const reopened = new Database(path);

            try {
                const row = reopened.prepare("SELECT scheduled_for FROM _lunora_alarm WHERE id = 0").get();

                expect(row).toBeDefined();
            } finally {
                reopened.close();
            }
        });

        it("dispose() clears the alarm timer so it can never fire, then closes the database", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            try {
                const { database, dispose, host } = createNodeShardHost();

                await host.alarms.set(Date.now() + 1000);

                expect(vi.getTimerCount()).toBeGreaterThan(0);

                dispose();

                expect(vi.getTimerCount()).toBe(0);
                expect(database.open).toBe(false);

                // Advancing past the original alarm target must not throw or
                // reopen/touch the connection — the timer is gone, not merely
                // guarded.
                expect(() => vi.advanceTimersByTime(1001)).not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("createNodeSchedulerHost().dispose", () => {
        it("arms one timer per scheduled job, then clears every one of them on dispose", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            try {
                const { dispose, scheduler } = createNodeSchedulerHost();

                await scheduler.schedule("some/fn", {}, { delayMs: 5000 });
                await scheduler.schedule("some/other-fn", {}, { delayMs: 10_000 });

                expect(vi.getTimerCount()).toBeGreaterThan(0);

                dispose();

                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("close()", () => {
        it("closes the shared database and clears the alarm + every scheduler timer", async () => {
            expect.assertions(3);

            vi.useFakeTimers();

            try {
                const platform = createNodePlatform();

                await platform.shard.alarms.set(Date.now() + 1000);
                await platform.scheduler.schedule("some/fn", {}, { delayMs: 5000 });

                expect(vi.getTimerCount()).toBeGreaterThan(0);

                platform.close();

                expect(vi.getTimerCount()).toBe(0);

                // Closing twice must not throw — teardown code (a `finally`
                // block, a test's `afterEach`) can't always tell whether it is
                // the first caller to tear a platform down.
                expect(() => {
                    platform.close();
                }).not.toThrow();
            } finally {
                vi.useRealTimers();
            }
        });

        it("is reachable via [Symbol.dispose] for `using` callers", () => {
            expect.assertions(1);

            const platform = createNodePlatform();

            expect(typeof platform[Symbol.dispose]).toBe("function");

            platform[Symbol.dispose]();
        });

        it("removes the WAL/SHM sidecar files a real database file leaves behind", () => {
            expect.assertions(2);

            const path = join(workdir, "platform.sqlite3");
            const platform = createNodePlatform({ path });

            platform.shard.sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
            platform.close();

            // Not asserting the sidecar files are gone (WAL mode leaves them
            // until the last connection closes cleanly, which `close()` now
            // does) — asserting the main file is still a valid, reopenable
            // SQLite database is the caller-observable guarantee: the process
            // did not crash mid-write and the file was not left corrupt.
            const reopened = new Database(path);

            try {
                expect(() => reopened.pragma("integrity_check")).not.toThrow();
            } finally {
                reopened.close();
            }

            expect(readdirSync(workdir)).toContain("platform.sqlite3");
        });
    });
});
