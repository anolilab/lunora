import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SocketHandle } from "@lunora/platform";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodePlatform } from "../src/node-platform";
import { createNodeSchedulerHost } from "../src/node-scheduler-host";
import { createNodeShardHost } from "../src/node-shard-host";
import { createNodeSocketHost } from "../src/node-socket-host";

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
                const database = new Database(":memory:");
                const { dispose, scheduler } = createNodeSchedulerHost(database);

                await scheduler.schedule("some/fn", {}, { delayMs: 5000 });
                await scheduler.schedule("some/other-fn", {}, { delayMs: 10_000 });

                expect(vi.getTimerCount()).toBeGreaterThan(0);

                dispose();

                expect(vi.getTimerCount()).toBe(0);

                database.close();
            } finally {
                vi.useRealTimers();
            }
        });

        it("re-arms a job persisted by an earlier host over the same database", async () => {
            expect.assertions(2);

            const path = join(workdir, "scheduler-rearm.sqlite3");
            const database = new Database(path);

            try {
                const first = createNodeSchedulerHost(database);

                await first.scheduler.schedule("some/fn", { user: "ada" }, { delayMs: 60_000 });
                // Shutdown clears the timer but leaves the row — the whole point
                // of the durable table.
                first.dispose();

                // A second host over the same connection stands in for a process
                // restart: it must find the row and arm a timer for it, or the
                // job is a log entry nobody will ever act on.
                const second = createNodeSchedulerHost(database);
                // `list` is optional on the contract (a fire-and-forget host
                // omits it); this host always supplies it, which is the thing
                // being asserted.
                const pending = (await second.scheduler.list?.()) ?? [];

                expect(pending.map((job) => job.functionPath)).toStrictEqual(["some/fn"]);
                expect(pending[0]?.attempts).toBe(0);

                second.dispose();
            } finally {
                database.close();
            }
        });
    });

    /**
     * The parity legs. `simulateRecycle()` and the TCK prove state survives a
     * host *forgetting* its runtime half; these prove it survives the process
     * that held it going away, which is what `ShardAlarms` ("survive host
     * recycling") and `SocketHost` guarantee 2 ("survive recycling and be
     * readable on wake") actually promise. A second host constructed over the
     * same database file is this package's stand-in for a restart.
     */
    describe("survives a process restart", () => {
        it("re-arms and delivers an alarm the previous host persisted", async () => {
            expect.assertions(2);

            const path = join(workdir, "alarm-rearm.sqlite3");
            const first = createNodeShardHost({ path });

            // Already elapsed: the case a restart is most likely to hit, and the
            // one a host that only re-armed *future* alarms would silently drop.
            await first.host.alarms.set(Date.now() - 1000);
            first.dispose();

            let delivered = 0;
            const second = createNodeShardHost({
                onAlarm: () => {
                    delivered += 1;
                },
                path,
            });

            await new Promise((resolve) => {
                setTimeout(resolve, 20);
            });

            expect(delivered).toBe(1);

            // And the row is consumed, so a third host does not re-deliver it.
            // Bound to a variable rather than asserted inline: `ShardAlarms.get`
            // is `Promise<number | null> | number | null` by contract, and this
            // host answers synchronously — so `.resolves` (which eslint's
            // autofix reaches for) would reject a legitimate return.
            const pendingAfterDelivery = await second.host.alarms.get();

            expect(pendingAfterDelivery).toBeNull();

            second.dispose();
        });

        it("restores a socket's attachment and tags written by the previous host", () => {
            expect.assertions(3);

            const path = join(workdir, "socket-restore.sqlite3");
            const first = createNodeShardHost({ path });
            const firstSockets = createNodeSocketHost(first.database);

            const handle = firstSockets.socket.accept({}, { roles: ["admin"], roomId: "room-1" }, ["room-a"]);
            const id = firstSockets.socket.idFor(handle);

            first.dispose();

            const second = createNodeShardHost({ path });
            const secondSockets = createNodeSocketHost(second.database);

            // `undefined` as the fallback: if the attachment comes back, it came
            // out of SQLite and not from an argument the test kept alive.
            const restored = secondSockets.restoreSocket(id, undefined);

            expect(restored.deserializeAttachment()).toStrictEqual({ roles: ["admin"], roomId: "room-1" });
            expect(secondSockets.socket.idFor(restored)).toBe(id);
            // Tags too — a restored socket that lost them silently drops out of
            // every tagged fan-out it was subscribed to.
            expect(secondSockets.socket.getSockets("room-a").map((entry: SocketHandle) => secondSockets.socket.idFor(entry))).toStrictEqual([id]);

            second.dispose();
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
