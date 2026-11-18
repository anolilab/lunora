import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";

import { resolveShard } from "@lunora/platform";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrainTimer } from "../src/drain-deadline";
import { drainTogether } from "../src/drain-deadline";
import { createNodePlatform } from "../src/node-platform";
import { createNodeShardRegistry } from "../src/node-shard-registry";
import type { NodeServerEnd } from "../src/node-socket-pair";

/** Each logged line as the console prints it: the format string with its arguments applied. */
const printed = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((args) => format(...args));

/** This package's built entry, which the child-process test runs on plain Node. */
const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs");

/** A promise the test settles by hand: work that is "in flight" until the test says otherwise. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

/** One full event-loop turn: every microtask a non-waiting drain would need to settle has run. */
const turn = async (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve);
    });

describe("shard drain", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("waits for an in-flight onFetch, such as a cron delivery, before the registry reports idle", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));
            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("waits for work a shard handed to waitUntil, and for work a request started there", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: (_request, shard) => {
                const background = async (): Promise<void> => {
                    await gate.promise;
                    events.push("background done");
                };

                shard.shard.waitUntil?.(background());

                return new Response("ok");
            },
        });

        try {
            await registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));

            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await drained;

            expect(events).toStrictEqual(["background done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("includes the registry's shards in the platform's drain", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const platform = createNodePlatform({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = resolveShard(platform.directory, "a").fetch(new Request("https://shard.internal/rpc"));
            const drained = platform.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            platform.close();
        }
    });
});

/** A deadline the test fires by hand: no clock runs in these tests. */
const manualTimer = (): { fire: () => void; timer: DrainTimer } => {
    let onExpire: () => void = () => {};

    return {
        fire: () => {
            onExpire();
        },
        timer: (_ms, expire) => {
            onExpire = expire;

            return () => {
                onExpire = () => {};
            };
        },
    };
};

describe("shard drain passes", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sees waitUntil work added to a shard whose own drain already finished", async () => {
        expect.assertions(2);

        const gateA = deferred();
        const gateB = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry();

        try {
            const shardB = registry.shardFor("b");

            // Shard a's background work, once released, hands new work to shard b, which the first pass already found idle.
            registry.shardFor("a").shard.waitUntil?.(
                (async (): Promise<void> => {
                    await gateA.promise;
                    shardB.shard.waitUntil?.(
                        (async (): Promise<void> => {
                            await gateB.promise;
                            events.push("b done");
                        })(),
                    );
                })(),
            );

            const drained = registry.drain().then((result) => {
                events.push("drained");

                return result;
            });

            gateA.release();
            await turn();
            gateB.release();

            await expect(drained).resolves.toStrictEqual({ failed: [], pending: [], timedOut: false });
            expect(events).toStrictEqual(["b done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("sees a shard opened while draining", async () => {
        expect.assertions(1);

        const gateA = deferred();
        const gateC = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry();

        try {
            registry.shardFor("a").shard.waitUntil?.(
                (async (): Promise<void> => {
                    await gateA.promise;
                    // A shard that did not exist when the drain began.
                    registry.shardFor("c").shard.waitUntil?.(
                        (async (): Promise<void> => {
                            await gateC.promise;
                            events.push("c done");
                        })(),
                    );
                })(),
            );

            const drained = registry.drain().then(() => events.push("drained"));

            gateA.release();
            await turn();
            gateC.release();
            await drained;

            expect(events).toStrictEqual(["c done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("gives up at the deadline, naming each shard and how much work it still had, never the work itself", async () => {
        expect.assertions(3);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const { fire, timer } = manualTimer();
        const never = deferred();
        const registry = createNodeShardRegistry({
            onFetch: async () => {
                await never.promise;

                return new Response("never");
            },
        });

        try {
            registry.shardFor("stuck").shard.waitUntil?.(never.promise);
            registry.shardFor("stuck").shard.waitUntil?.(never.promise);
            registry.directory
                .getByName("busy")
                .fetch(new Request("https://shard.internal/rpc?token=secret-token-value", { body: '{"card":"4242"}', method: "POST" }))
                .catch(() => undefined);

            const drained = registry.drain({ timer });

            fire();

            const result = await drained;

            expect(result).toStrictEqual({ failed: [], pending: ["shard busy: 1 request in flight", "shard stuck: 2 waitUntil tasks"], timedOut: true });
            expect(printed(logged)).toContainEqual(expect.stringContaining("shard busy: 1 request in flight, shard stuck: 2 waitUntil tasks"));
            expect(printed(logged).join("\n")).not.toMatch(/secret-token-value|4242/u);
        } finally {
            never.release();
            registry.close();
        }
    });

    it("runs the whole platform drain under one deadline, so one firing ends both the host and the shard waits", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        // Keeps only the last callback it was given, as a simple injected clock does: a second deadline would replace the first.
        const { fire, timer } = manualTimer();
        const never = deferred();
        const platform = createNodePlatform();

        try {
            platform.shard.waitUntil?.(never.promise);
            resolveShard(platform.directory, "stuck")
                .fetch(new Request("https://shard.internal/rpc"))
                .catch(() => undefined);

            const drained = platform.drain({ timer });

            fire();

            await expect(drained).resolves.toStrictEqual({ failed: [], pending: ["waitUntil work on the platform host"], timedOut: true });
            // Logged before the caller closes anything, so the cut-off work is on record.
            expect(printed(logged)).toContainEqual(
                expect.stringContaining("platform drain deadline passed with work still running: waitUntil work on the platform host"),
            );
        } finally {
            never.release();
            platform.close();
        }
    });

    it("does not report idle while a shard request that host work started after the registry drained is still running", async () => {
        expect.assertions(1);

        const hostGate = deferred();
        const requestGate = deferred();
        const events: string[] = [];
        const platform = createNodePlatform({
            onFetch: async () => {
                await requestGate.promise;
                events.push("request done");

                return new Response("ok");
            },
        });

        try {
            // Host background work that, once released, hands a request to a shard the registry already found idle, as a due
            // job's delivery does. The host work itself finishes at once.
            platform.shard.waitUntil?.(
                (async (): Promise<void> => {
                    await hostGate.promise;
                    resolveShard(platform.directory, "late")
                        .fetch(new Request("https://shard.internal/rpc"))
                        .catch(() => undefined);
                })(),
            );

            const drained = platform.drain().then(() => events.push("drained"));

            hostGate.release();
            await turn();
            requestGate.release();
            await drained;

            expect(events).toStrictEqual(["request done", "drained"]);
        } finally {
            platform.close();
        }
    });

    it("keeps a failed alarm's retry when shutdown follows it, so the alarm fires after a restart", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-retry-"));
        const arrived = deferred();
        const failAlarm = deferred();
        const releaseTransaction = deferred();
        const transactionOpen = deferred();
        const first = createNodeShardRegistry({
            directory,
            onAlarm: async () => {
                arrived.release();
                await failAlarm.promise;

                throw new Error("alarm failed");
            },
        });

        try {
            const { shard } = first.shardFor("a");

            await shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            // Another task's transaction is open when the handler fails, so the retry row has to wait for it to end.
            const transaction = shard.transaction(async () => {
                transactionOpen.release();
                await releaseTransaction.promise;
            });

            await transactionOpen.promise;

            // As a shutdown does: close the moment the drain reports the shard idle.
            const shutDown = async (): Promise<void> => {
                await first.drain({ timer: () => () => {} });
                first.close();
            };
            const drained = shutDown();

            failAlarm.release();
            await turn();
            releaseTransaction.release();
            // A close that came too early ends this transaction's connection under it; that is the failure under test.
            await transaction.catch(() => undefined);
            // The deferred retry write runs on its own short timer once the transaction has ended.
            await vi.advanceTimersByTimeAsync(50);
            await drained;
        } finally {
            first.close();
        }

        const fired = deferred();
        const second = createNodeShardRegistry({
            directory,
            onAlarm: () => {
                fired.release();
            },
        });

        try {
            // Opening the shard re-arms its persisted alarm; the retry backoff is well under a second.
            second.shardFor("a");
            await vi.advanceTimersByTimeAsync(1000);

            await expect(fired.promise).resolves.toBeUndefined();
        } finally {
            second.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it.each([2_147_483_648, -1, 1.5, Number.NaN])("refuses a drain timeoutMs of %d, which Node would run after 1 ms or never", async (timeoutMs) => {
        expect.assertions(1);

        const registry = createNodeShardRegistry();

        try {
            await expect(registry.drain({ timeoutMs })).rejects.toThrow("a drain timeoutMs must be a whole number of milliseconds from 0 to 2147483647");
        } finally {
            registry.close();
        }
    });

    it("settles a failed alarm whose retry waits on a transaction that replaces the alarm timer, and the alarm survives a restart", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-retry-slot-"));
        const arrived = deferred();
        const failAlarm = deferred();
        const transactionOpen = deferred();
        const releaseTransaction = deferred();
        const { fire, timer } = manualTimer();
        const first = createNodeShardRegistry({
            directory,
            onAlarm: async () => {
                arrived.release();
                await failAlarm.promise;

                throw new Error("alarm failed");
            },
        });
        let result: unknown;

        try {
            const { shard } = first.shardFor("a");

            await shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            // The handler fails while this transaction is open, so its retry has to wait; the transaction then commits a set,
            // which re-arms the alarm timer, the slot the retry's wait used to share.
            const transaction = shard.transaction(async () => {
                transactionOpen.release();
                await releaseTransaction.promise;
                await shard.alarms.set(Date.now() + 5000);
            });

            await transactionOpen.promise;
            failAlarm.release();
            await turn();
            releaseTransaction.release();
            await transaction;

            const drained = first.drain({ timer });

            await vi.advanceTimersByTimeAsync(50);
            await turn();
            // Only reached by a drain still waiting: a stranded delivery would report the deadline instead of settling.
            fire();
            result = await drained;
        } finally {
            first.close();
        }

        expect(result).toStrictEqual({ failed: [], pending: [], timedOut: false });

        const fired = deferred();
        const second = createNodeShardRegistry({
            directory,
            onAlarm: () => {
                fired.release();
            },
        });

        try {
            second.shardFor("a");
            await vi.advanceTimersByTimeAsync(6000);

            await expect(fired.promise).resolves.toBeUndefined();
        } finally {
            second.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("settles a retry still waiting when its shard closes, logging that it was given up", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const arrived = deferred();
        const failAlarm = deferred();
        const transactionOpen = deferred();
        const never = deferred();
        const registry = createNodeShardRegistry({
            onAlarm: async () => {
                arrived.release();
                await failAlarm.promise;

                throw new Error("alarm failed");
            },
        });

        try {
            const { shard } = registry.shardFor("a");

            await shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            // A transaction that never ends: the retry can only wait, until the shard is closed under it.
            shard
                .transaction(async () => {
                    transactionOpen.release();
                    await never.promise;
                })
                .catch(() => undefined);
            await transactionOpen.promise;
            failAlarm.release();
            await turn();
        } finally {
            registry.close();
            never.release();
            vi.useRealTimers();
        }

        expect(printed(logged)).toContainEqual(
            expect.stringContaining("alarm retry on shard a given up: the database closed while it waited for another transaction to end"),
        );
    });

    it("logs and reports an alarm retry that cannot be written, and still waits for every other shard", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-retry-fail-"));
        const arrived = deferred();
        const failAlarm = deferred();
        const otherGate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            directory,
            onAlarm: async () => {
                arrived.release();
                await failAlarm.promise;

                throw new Error("alarm failed");
            },
        });

        try {
            await registry.shardFor("a").shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            // The alarm row is already consumed; dropping its table from another connection makes the retry's write throw,
            // as a SQLITE_BUSY or a broken file would.
            const file = readdirSync(directory).find((name) => name.endsWith(".sqlite3"));
            const other = new Database(join(directory, String(file)));

            other.exec("DROP TABLE _lunora_alarm");
            other.close();

            const otherShard = async (): Promise<void> => {
                await otherGate.promise;
                events.push("other shard done");
            };

            registry.shardFor("b").shard.waitUntil?.(otherShard());

            const drained = registry.drain({ timer: () => () => {} }).then((result) => {
                events.push("drained");

                return result;
            });

            failAlarm.release();
            // Every write attempt fails the same way; the backoff between them runs on the fake clock.
            await vi.advanceTimersByTimeAsync(1000);
            await turn();
            otherGate.release();

            const result = await drained;

            expect(result).toStrictEqual({
                failed: [expect.stringMatching(/^shard a: the retry of the alarm due .+ could not be written$/u)],
                pending: [],
                timedOut: false,
            });
            // The failure did not cut the drain short: the other shard's work was still waited for.
            expect(events).toStrictEqual(["other shard done", "drained"]);

            const line = printed(logged).find((entry) => entry.includes("could not be written")) ?? "";

            expect(line).toContain("on shard a could not be written after 4 attempts, so that alarm is lost");
            expect(line).toContain("no such table: _lunora_alarm");
        } finally {
            registry.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("tries a failed retry write again, so brief contention does not lose the alarm", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-retry-busy-"));
        const arrived = deferred();
        const failAlarm = deferred();
        const first = createNodeShardRegistry({
            directory,
            onAlarm: async () => {
                arrived.release();
                await failAlarm.promise;

                throw new Error("alarm failed");
            },
        });
        let result: unknown;

        try {
            await first.shardFor("a").shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            // The first write fails (the table is gone, as under contention); the table is back before the next attempt.
            const file = join(directory, String(readdirSync(directory).find((name) => name.endsWith(".sqlite3"))));
            const other = new Database(file);

            other.exec("DROP TABLE _lunora_alarm");

            const drained = first.drain({ timer: () => () => {} });

            failAlarm.release();
            await turn();
            other.exec("CREATE TABLE _lunora_alarm (id INTEGER PRIMARY KEY CHECK (id = 0), scheduled_for INTEGER NOT NULL)");
            other.close();
            await vi.advanceTimersByTimeAsync(150);
            result = await drained;
        } finally {
            first.close();
        }

        expect(result).toStrictEqual({ failed: [], pending: [], timedOut: false });

        const fired = deferred();
        const second = createNodeShardRegistry({
            directory,
            onAlarm: () => {
                fired.release();
            },
        });

        try {
            second.shardFor("a");
            await vi.advanceTimersByTimeAsync(1000);

            await expect(fired.promise).resolves.toBeUndefined();
        } finally {
            second.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("waits for a scheduler delivery running through a custom onDispatch before the platform reports idle", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const arrived = deferred();
        const dispatchGate = deferred();
        const events: string[] = [];
        const platform = createNodePlatform({
            onDispatch: async () => {
                arrived.release();
                await dispatchGate.promise;
                events.push("dispatch done");
            },
        });

        try {
            await platform.scheduler.schedule("jobs:run", {}, { delayMs: 0 });
            await vi.advanceTimersByTimeAsync(0);
            await arrived.promise;

            const drained = platform.drain({ timer: () => () => {} }).then(() => events.push("drained"));

            await turn();
            dispatchGate.release();
            await drained;

            expect(events).toStrictEqual(["dispatch done", "drained"]);
        } finally {
            platform.close();
            vi.useRealTimers();
        }
    });

    it("names every scheduled job and cron tick still running when the platform drain's deadline passes", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const never = deferred();
        const { fire, timer } = manualTimer();
        const platform = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:tick", name: "tick" }] },
            onDispatch: async () => {
                await never.promise;
            },
        });

        try {
            const job = await platform.scheduler.schedule("jobs:run", {}, { delayMs: 0 });

            // The minute boundary: the cron tick and the job are both in flight now.
            await vi.advanceTimersByTimeAsync(30_000);

            const drained = platform.drain({ timer });

            fire();

            const result = await drained;

            expect(result.pending).toStrictEqual(expect.arrayContaining([`scheduled job jobs:run (${job.id})`, 'cron job "tick" (reports:tick)']));
            expect(printed(logged)).toContainEqual(expect.stringContaining(`platform drain deadline passed with work still running: `));
        } finally {
            never.release();
            platform.close();
            vi.useRealTimers();
        }
    });

    it("disposes a shard whose socket close handler never settles when forced, and logs it", () => {
        expect.assertions(3);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const never = deferred();
        const waiting = createNodeShardRegistry();
        const forced = createNodeShardRegistry();

        // One shard in each registry with a close handler that never settles, as a stuck webSocketClose would be.
        const stuckShard = (registry: ReturnType<typeof createNodeShardRegistry>) => {
            const shard = registry.shardFor("stuck");

            shard.inbound.onClose(async () => never.promise);
            // The contract types the pair's ends as unknown; this host's server end is a NodeServerEnd.
            (shard.sockets.newPair().server as NodeServerEnd).close(1000, "bye");

            return shard;
        };
        const waitingShard = stuckShard(waiting);
        const forcedShard = stuckShard(forced);

        try {
            waiting.close();
            forced.close({ force: true });

            // Unforced, the database stays open for the handler; forced, it is closed now.
            expect(() => waitingShard.sockets.accept({}, undefined, [])).not.toThrow();
            expect(() => forcedShard.sockets.accept({}, undefined, [])).toThrow("platform closed");
            expect(printed(logged)).toContainEqual(expect.stringContaining("closed 1 shard(s) with a socket close handler still running: stuck"));
        } finally {
            never.release();
        }
    });

    it("closes every shard when one fails to close, then reports that one", () => {
        expect.assertions(4);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const registry = createNodeShardRegistry();
        const first = registry.shardFor("a");
        const second = registry.shardFor("b");

        // The driver refuses the first close, as a busy connection does; the second shard must still be closed.
        vi.spyOn(Database.prototype, "close").mockImplementationOnce(() => {
            throw new Error("database is busy");
        });

        expect(() => {
            registry.close({ force: true });
        }).toThrow("1 shard(s) failed to close: a");
        expect(() => second.sockets.accept({}, undefined, [])).toThrow("platform closed");
        expect(printed(logged)).toContainEqual(expect.stringContaining("shard a failed to close"));
        expect(first.shardKey).toBe("a");
    });

    it("runs every platform teardown when one throws, then reports it", async () => {
        expect.assertions(2);

        vi.spyOn(console, "error").mockImplementation(() => {});

        const platform = createNodePlatform();

        // A request opens a registry shard, so its database is the first one the platform closes; that close fails.
        await resolveShard(platform.directory, "stuck").fetch(new Request("https://shard.internal/rpc"));
        vi.spyOn(Database.prototype, "close").mockImplementationOnce(() => {
            throw new Error("database is busy");
        });

        expect(() => {
            platform.close({ force: true });
        }).toThrow("resource(s) failed to close");
        // The platform's own database, closed after the registry, was still closed.
        expect(() => platform.sockets.accept({}, undefined, [])).toThrow("platform closed");
    });

    it("re-arms a persisted alarm at startup, so it fires after a restart with no request to its shard", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        const directory = mkdtempSync(join(tmpdir(), "lunora-alarm-restore-"));
        const first = createNodeShardRegistry({ directory });

        await first.shardFor("quiet").shard.alarms.set(Date.now() + 1000);
        // A shard with no alarm, which a restart must leave closed.
        first.shardFor("idle");
        first.close();

        const fired = deferred();
        const second = createNodeShardRegistry({
            directory,
            onAlarm: () => {
                fired.release();
            },
        });

        try {
            expect(second.rearmPersistedAlarms()).toStrictEqual(["quiet"]);

            await vi.advanceTimersByTimeAsync(2000);

            await expect(fired.promise).resolves.toBeUndefined();
        } finally {
            second.close();
            vi.useRealTimers();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("does not re-arm an alarm whose handler deleted it before throwing", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const failed = deferred();
        const registry = createNodeShardRegistry({
            onAlarm: async (shard) => {
                // The handler decides there is no next wakeup, then fails.
                await shard.shard.alarms.delete();
                failed.release();

                throw new Error("alarm failed after deleting itself");
            },
        });

        try {
            const { shard } = registry.shardFor("a");

            await shard.alarms.set(Date.now());
            await vi.advanceTimersByTimeAsync(0);
            await failed.promise;
            await registry.drain({ timer: () => () => {} });

            await expect(Promise.resolve(shard.alarms.get())).resolves.toBeNull();
        } finally {
            registry.close();
            vi.useRealTimers();
        }
    });

    it("drains several registries until all are idle in one pass, including work one hands another after it drained", async () => {
        expect.assertions(1);

        const gateA = deferred();
        const gateB = deferred();
        const events: string[] = [];
        const first = createNodeShardRegistry();
        const second = createNodeShardRegistry();

        try {
            // Work on the first registry that, once released, writes to the second, which the first pass found idle.
            first.shardFor("a").shard.waitUntil?.(
                (async (): Promise<void> => {
                    await gateA.promise;
                    second.shardFor("b").shard.waitUntil?.(
                        (async (): Promise<void> => {
                            await gateB.promise;
                            events.push("second registry write");
                        })(),
                    );
                })(),
            );

            const drained = drainTogether([first, second], { timer: () => () => {} }).then(() => events.push("drained"));

            gateA.release();
            await turn();
            gateB.release();
            await drained;

            expect(events).toStrictEqual(["second registry write", "drained"]);
        } finally {
            first.close();
            second.close();
        }
    });

    it("keeps the process alive until the deadline, so a stalled shard cannot end it silently", async () => {
        expect.assertions(2);

        // A child process, because only there can the event loop run empty: the stalled waitUntil has no I/O behind it, so the
        // deadline's own timer is the one thing that can keep the process alive long enough to report.
        const directory = mkdtempSync(join(tmpdir(), "lunora-drain-alive-"));
        const script = join(directory, "drain.mjs");

        writeFileSync(
            script,
            [
                `import { createNodeShardRegistry } from ${JSON.stringify(pathToFileURL(DIST_ENTRY).href)};`,
                "const registry = createNodeShardRegistry();",
                'registry.shardFor("stalled").shard.waitUntil(new Promise(() => {}));',
                "const result = await registry.drain({ timeoutMs: 0 });",
                'console.log("RESULT", JSON.stringify(result));',
            ].join("\n"),
            "utf8",
        );

        try {
            const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";

            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf8");
            });

            const code = await new Promise<number | null>((resolve) => {
                child.once("exit", resolve);
            });

            expect(code).toBe(0);
            expect(stdout).toContain(`RESULT ${JSON.stringify({ failed: [], pending: ["shard stalled: 1 waitUntil task"], timedOut: true })}`);
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});

describe("background failures", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("logs a rejected waitUntil with the error object, so its stack and cause print", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const registry = createNodeShardRegistry();
        const failure = new Error("background write failed", { cause: new Error("disk full") });

        try {
            registry.shardFor("a").shard.waitUntil?.(Promise.reject(failure));
            await registry.drain();

            expect(printed(logged)).toContainEqual(expect.stringContaining("waitUntil on shard a failed"));
            // The error object itself is the last argument, so the console prints its stack and cause.
            expect((logged.mock.calls[0]?.at(-1) as Error).cause).toStrictEqual(new Error("disk full"));
        } finally {
            registry.close();
        }
    });

    it("logs a scheduled job whose delivery throws, naming the job, before it is retried", async () => {
        expect.assertions(2);

        const failure = new Error("delivery refused");
        const reported = deferred();
        const logged = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
            if (parts.includes(failure)) {
                reported.release();
            }
        });
        const platform = createNodePlatform({
            onDispatch: () => {
                throw failure;
            },
        });

        try {
            await platform.scheduler.schedule("jobs:run", {}, { delayMs: 0, retry: { maxAttempts: 1 } });
            await reported.promise;

            expect(printed(logged)).toContainEqual(expect.stringContaining("scheduled job jobs:run"));
            expect(logged.mock.calls[0]?.at(-1)).toBe(failure);
        } finally {
            platform.close();
        }
    });
});
