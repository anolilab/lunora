import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeSchedulerHost } from "../src/node-scheduler-host";
import { createNodeShardHost } from "../src/node-shard-host";

const CRON_ROW_READ = "SELECT * FROM _lunora_scheduler_crons WHERE key = ?";
const CRON_SET_READ = "SELECT * FROM _lunora_scheduler_crons";

/** Forward every member of `target` except `override`'s, binding methods to `target`. */
const forwardExcept = <T extends object>(target: T, override: PropertyKey, replacement: unknown): T =>
    new Proxy(target, {
        get(inner, name) {
            if (name === override) {
                return replacement;
            }

            const value: unknown = Reflect.get(inner, name, inner);

            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
        },
    });

/**
 * `database`, with the per-key cron row read throwing while `failNext` has
 * failures left: a stand-in for a SQLite error (a locked or corrupt file) on the
 * scheduler's timer path.
 */
const withFailingCronRead = (database: Database.Database): { database: Database.Database; failNext: (count: number) => void } => {
    let failures = 0;

    const prepare = (source: string): Database.Statement => {
        const statement = database.prepare(source);

        if (source !== CRON_ROW_READ) {
            return statement;
        }

        const get = (...values: unknown[]): unknown => {
            if (failures > 0) {
                failures -= 1;

                throw new Error("SQLITE_BUSY: database is locked");
            }

            return statement.get(...values);
        };

        return forwardExcept(statement, "get", get);
    };

    return {
        database: forwardExcept(database, "prepare", prepare),
        failNext: (count) => {
            failures = count;
        },
    };
};

describe("createNodeSchedulerHost", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    describe("cron dialect", () => {
        it("fires a weekday cron on the Cloudflare weekday, not the default dialect's", async () => {
            expect.assertions(2);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00Z") });

            const database = new Database(":memory:");
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                // Weekday 1 is Sunday under Cloudflare's dialect and Monday under the default one. From Sunday
                // noon UTC the Cloudflare fire is six days away; the default dialect would fire within the day.
                await host.scheduler.cron?.("0 0 * * 1", "reports:weekly", {});
                await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

                expect(onDispatch).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledWith("reports:weekly");
            } finally {
                host.dispose();
                database.close();
            }
        });
    });

    describe("cron seconds field", () => {
        it.each([
            ["six fields, seconds-leading", "* * * * * *", 1000],
            ["five fields", "* * * * *", 60 * 1000],
        ])("registers and fires an expression of %s", async (_label, expression, advanceMs) => {
            expect.assertions(2);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00Z") });

            const database = new Database(":memory:");
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                await expect(host.scheduler.cron?.(expression, "tasks:tick", {})).resolves.toBeUndefined();

                await vi.advanceTimersByTimeAsync(advanceMs);

                expect(onDispatch).toHaveBeenCalledWith("tasks:tick");
            } finally {
                host.dispose();
                database.close();
            }
        });
    });

    describe("declared crons", () => {
        it("does not re-arm a cron removed while its tick was in flight", async () => {
            expect.assertions(2);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const database = new Database(":memory:");
            let release: (() => void) | undefined;
            const onDispatch = vi.fn<(functionPath: string) => Promise<void>>(
                async () =>
                    new Promise<void>((resolve) => {
                        release = resolve;
                    }),
            );
            const host = createNodeSchedulerHost(database, { onDispatch });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:tick", name: "tick" }]);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);

                host.declareCrons([]);
                release?.();
                await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("fires on UTC, not on the process's local zone", async () => {
            expect.assertions(2);

            const previousTz = process.env.TZ;

            // New York is UTC-5 here: a local-zone parse fires `0 9 * * *` at 14:00 UTC.
            process.env.TZ = "America/New_York";
            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00Z") });

            const database = new Database(":memory:");
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                host.declareCrons([{ args: {}, expression: "0 9 * * *", functionPath: "reports:daily", name: "daily" }]);
                await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);

                expect(onDispatch).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(18 * 60 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledWith("reports:daily");
            } finally {
                host.dispose();
                database.close();

                if (previousTz === undefined) {
                    delete process.env.TZ;
                } else {
                    process.env.TZ = previousTz;
                }
            }
        });

        it("skips the ticks a slow run covers rather than overlapping it", async () => {
            expect.assertions(2);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const database = new Database(":memory:");
            let release: (() => void) | undefined;
            const onDispatch = vi.fn<(functionPath: string) => Promise<void>>(
                async () =>
                    new Promise<void>((resolve) => {
                        release = resolve;
                    }),
            );
            const host = createNodeSchedulerHost(database, { onDispatch });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:slow", name: "slow" }]);
                // First tick at 12:01; the run is still going through 12:02 and 12:03.
                await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);

                release?.();
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(2);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("does not start a second run when a retained cron is re-declared mid-run", async () => {
            expect.assertions(4);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const database = new Database(":memory:");
            const releases: (() => void)[] = [];
            const onDispatch = vi.fn<(functionPath: string) => Promise<void>>(
                async () =>
                    new Promise<void>((resolve) => {
                        releases.push(resolve);
                    }),
            );
            const host = createNodeSchedulerHost(database, { onDispatch });
            const declared = [{ args: {}, expression: "* * * * *", functionPath: "reports:slow", name: "slow" }];

            try {
                host.declareCrons(declared);
                // 12:01 tick starts and stays pending; the refresh lands mid-run.
                await vi.advanceTimersByTimeAsync(60 * 1000);
                host.declareCrons(declared);
                await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);

                releases[0]?.();
                await vi.advanceTimersByTimeAsync(0);

                // The settled run re-armed exactly one timer for the next minute.
                expect(vi.getTimerCount()).toBe(1);

                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(2);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("logs a failed tick with the job, the error and the next run, and keeps the schedule", async () => {
            expect.assertions(5);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const database = new Database(":memory:");
            const failure = new Error("shard answered 503");
            const onDispatch = vi.fn<(functionPath: string) => Promise<void>>(async () => {
                throw failure;
            });
            const host = createNodeSchedulerHost(database, { onDispatch });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:tick", name: "tick" }]);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(error).toHaveBeenCalledTimes(1);
                expect(error.mock.calls[0]?.[0]).toContain('job "tick" (reports:tick)');
                expect(error.mock.calls[0]?.[0]).toContain("next run: 2026-11-01T12:02:00.000Z");
                expect(error.mock.calls[0]?.[1]).toBe(failure);

                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(2);
            } finally {
                host.dispose();
                database.close();
                error.mockRestore();
            }
        });

        it("re-arms from a changed expression instead of firing the new job on the old timer", async () => {
            expect.assertions(2);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const database = new Database(":memory:");
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:x", name: "x" }]);
                // Another process moves the job from every minute to daily at 09:00 UTC.
                database.prepare("UPDATE _lunora_scheduler_crons SET expression = '0 9 * * *' WHERE key = 'declared:x'").run();
                await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

                expect(onDispatch).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(20 * 60 * 60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("logs and re-arms when the row read before a tick throws, instead of crashing the timer", async () => {
            expect.assertions(3);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const real = new Database(":memory:");
            const { database, failNext } = withFailingCronRead(real);
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:x", name: "x" }]);
                failNext(1);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(error.mock.calls[0]?.[0]).toContain("could not read its row before the tick");

                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(1);
                expect(error).toHaveBeenCalledTimes(1);
            } finally {
                host.dispose();
                real.close();
                error.mockRestore();
            }
        });

        it("logs and re-arms when settling a tick throws, so the job never goes quiet", async () => {
            expect.assertions(3);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const real = new Database(":memory:");
            const { database, failNext } = withFailingCronRead(real);
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                    // The pre-dispatch read already happened; fail the one after the dispatch.
                    failNext(1);
                },
            });

            try {
                host.declareCrons([{ args: {}, expression: "* * * * *", functionPath: "reports:x", name: "x" }]);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(error.mock.calls[0]?.[0]).toContain("could not read its row after its tick");

                failNext(0);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledTimes(2);
                expect(error.mock.calls[0]?.[0]).toContain("next run: 2026-11-01T12:02:00.000Z");
            } finally {
                host.dispose();
                real.close();
                error.mockRestore();
            }
        });

        it("refuses a cron() schedule that parses but never occurs", async () => {
            expect.assertions(1);

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);

            try {
                await expect(host.scheduler.cron?.("0 0 31 4,6,9,11 *", "reports:never", {})).rejects.toThrow(/never occurs/u);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it.each([
            ["an empty", ""],
            ["a blank", "   "],
            ["a one-field", "5"],
            ["a four-field", "0 9 * *"],
            ["a seven-field", "0 0 9 * * * *"],
        ])("refuses %s expression rather than letting the parser pad it into a schedule", async (_label, expression) => {
            expect.assertions(2);

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);

            try {
                expect(() => {
                    host.declareCrons([{ args: {}, expression, functionPath: "reports:x", name: "x" }]);
                }).toThrow(/invalid or never occurs/u);
                await expect(host.scheduler.cron?.(expression, "reports:x", {})).rejects.toThrow(/invalid or never occurs/u);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("still accepts a seconds-leading six-field expression", () => {
            expect.assertions(1);

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);

            try {
                expect(() => {
                    host.declareCrons([{ args: {}, expression: "*/30 * * * * *", functionPath: "reports:x", name: "x" }]);
                }).not.toThrow();
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("replaces the declared set atomically, so a declare racing another leaves only the last writer's set", () => {
            expect.assertions(3);

            const directory = mkdtempSync(join(tmpdir(), "lunora-declare-race-"));
            const path = join(directory, "scheduler.sqlite3");
            const realA = new Database(path);
            const realB = new Database(path);
            const hostB = createNodeSchedulerHost(realB);
            let racing = false;
            const setReadsOutsideTransaction: boolean[] = [];

            // Another process's declare runs in the gap after A reads the declared set. The gap
            // only exists when that read is outside A's write transaction: inside it, B could not
            // write until A committed, so the race cannot start there.
            const all = (statement: Database.Statement) => (): unknown[] => {
                const result = statement.all();

                if (racing) {
                    setReadsOutsideTransaction.push(!realA.inTransaction);

                    if (!realA.inTransaction) {
                        racing = false;
                        hostB.declareCrons([{ args: {}, expression: "0 4 * * *", functionPath: "reports:b", name: "b" }]);
                    }
                }

                return result;
            };
            const databaseA = forwardExcept(realA, "prepare", (source: string): Database.Statement => {
                const statement = realA.prepare(source);

                return source === CRON_SET_READ ? forwardExcept(statement, "all", all(statement)) : statement;
            });
            const hostA = createNodeSchedulerHost(databaseA);

            try {
                racing = true;
                hostA.declareCrons([{ args: {}, expression: "0 3 * * *", functionPath: "reports:a", name: "a" }]);

                const keys = realA
                    .prepare<[], { key: string }>("SELECT key FROM _lunora_scheduler_crons ORDER BY key")
                    .all()
                    .map((row) => row.key);

                expect(keys).toStrictEqual(["declared:a"]);
                expect(setReadsOutsideTransaction.length).toBeGreaterThan(0);
                expect(setReadsOutsideTransaction).not.toContain(true);
            } finally {
                hostA.dispose();
                hostB.dispose();
                realA.close();
                realB.close();
                rmSync(directory, { force: true, recursive: true });
            }
        });

        it("refuses two declared crons with the same name", () => {
            expect.assertions(1);

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);

            try {
                expect(() => {
                    host.declareCrons([
                        { args: {}, expression: "0 3 * * *", functionPath: "reports:a", name: "nightly" },
                        { args: {}, expression: "0 4 * * *", functionPath: "reports:b", name: "nightly" },
                    ]);
                }).toThrow(/"nightly"/u);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("leaves a cron registered through cron() alone", async () => {
            expect.assertions(1);

            vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

            const database = new Database(":memory:");
            const onDispatch = vi.fn<(functionPath: string) => void>();
            const host = createNodeSchedulerHost(database, {
                onDispatch: async (functionPath) => {
                    onDispatch(functionPath);
                },
            });

            try {
                await host.scheduler.cron?.("* * * * *", "reports:dynamic", {});
                host.declareCrons([]);
                await vi.advanceTimersByTimeAsync(60 * 1000);

                expect(onDispatch).toHaveBeenCalledWith("reports:dynamic");
            } finally {
                host.dispose();
                database.close();
            }
        });
    });

    describe("job lifecycle (get)", () => {
        it("reports running while the handler runs, succeeded after it, and canceled for a cancelled job", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const database = new Database(":memory:");
            let finish: (() => void) | undefined;
            const host = createNodeSchedulerHost(database, {
                onDispatch: async () =>
                    new Promise<void>((resolve) => {
                        finish = resolve;
                    }),
            });

            try {
                const job = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10 });
                const cancelled = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10_000 });

                await host.scheduler.cancel(cancelled.id);
                await vi.advanceTimersByTimeAsync(20);

                await expect(host.scheduler.get?.(job.id)).resolves.toMatchObject({ state: "running" });

                finish?.();
                await vi.advanceTimersByTimeAsync(0);

                await expect(host.scheduler.get?.(job.id)).resolves.toMatchObject({ attempts: 1, state: "succeeded" });
                await expect(host.scheduler.get?.(cancelled.id)).resolves.toMatchObject({ state: "canceled" });
                await expect(host.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it.each([
            ["succeeds", true, "succeeded"],
            ["fails", false, "canceled"],
        ])("records a job cancelled mid-dispatch by how its attempt ended when it %s", async (_label, ok, expected) => {
            expect.assertions(2);

            vi.useFakeTimers();

            const database = new Database(":memory:");
            let settle: { reject: (error: Error) => void; resolve: () => void } | undefined;
            const host = createNodeSchedulerHost(database, {
                onDispatch: async () =>
                    new Promise<void>((resolve, reject) => {
                        settle = { reject, resolve };
                    }),
            });

            try {
                const job = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10, retry: { maxAttempts: 1 } });

                await vi.advanceTimersByTimeAsync(20);
                await host.scheduler.cancel(job.id);
                if (ok) {
                    settle?.resolve();
                } else {
                    settle?.reject(new Error("handler failed"));
                }

                await vi.advanceTimersByTimeAsync(0);

                await expect(host.scheduler.get?.(job.id)).resolves.toMatchObject({ state: expected });
                await expect(host.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                host.dispose();
                database.close();
            }
        });

        it("forgets a finished job after seven days and deletes its row on the next construction", async () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);
            const job = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10_000 });

            await host.scheduler.cancel(job.id);

            vi.setSystemTime(Date.now() + 604_800_000 - 1);

            await expect(host.scheduler.get?.(job.id)).resolves.toMatchObject({ state: "canceled" });

            vi.setSystemTime(Date.now() + 1);

            await expect(host.scheduler.get?.(job.id)).resolves.toBeNull();

            host.dispose();

            const next = createNodeSchedulerHost(database);

            expect(database.prepare("SELECT count(*) AS n FROM _lunora_scheduler_jobs").get()).toStrictEqual({ n: 0 });

            next.dispose();
            database.close();
        });

        it("reclaims an expired cancelled row on a later cancel, without a restart or a completion", async () => {
            expect.assertions(1);

            vi.useFakeTimers();

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);
            const old = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10_000_000 });

            await host.scheduler.cancel(old.id);
            vi.setSystemTime(Date.now() + 604_800_000);

            const recent = await host.scheduler.schedule("jobs:run", {}, { delayMs: 10_000_000 });

            await host.scheduler.cancel(recent.id);

            expect(database.prepare("SELECT id FROM _lunora_scheduler_jobs").all()).toStrictEqual([{ id: recent.id }]);

            host.dispose();
            database.close();
        });

        it("sweeps retained rows through an index rather than a table scan", () => {
            expect.assertions(1);

            const database = new Database(":memory:");
            const host = createNodeSchedulerHost(database);
            const plan = database
                .prepare<[], { detail: string }>(
                    "EXPLAIN QUERY PLAN DELETE FROM _lunora_scheduler_jobs WHERE state IN ('succeeded', 'canceled') AND completed_at <= 0",
                )
                .all();

            expect(plan.map((step) => step.detail).join(" ")).toContain("USING INDEX");

            host.dispose();
            database.close();
        });

        it("adds the completion column to a database written before it existed", () => {
            expect.assertions(1);

            const database = new Database(":memory:");

            database.exec(
                "CREATE TABLE _lunora_scheduler_jobs (id TEXT PRIMARY KEY, function_path TEXT NOT NULL, args BLOB NOT NULL, scheduled_for INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry BLOB, state TEXT NOT NULL DEFAULT 'pending', claimed_at INTEGER)",
            );

            const host = createNodeSchedulerHost(database);
            const columns = database.prepare<[], { name: string }>("PRAGMA table_info(_lunora_scheduler_jobs)").all();

            expect(columns.some((column) => column.name === "completed_at")).toBe(true);

            host.dispose();
            database.close();
        });
    });

    it("delivers a pending job once when two hosts share one database file", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const delivered: string[] = [];
        const onDispatch = (functionPath: string): void => {
            delivered.push(functionPath);
        };
        const firstDatabase = new Database(path);
        const secondDatabase = new Database(path);
        const first = createNodeSchedulerHost(firstDatabase, { onDispatch });

        try {
            await first.scheduler.schedule("jobs:run", {}, { delayMs: 50 });

            // Constructed over the same file, so it re-arms the same pending row.
            const second = createNodeSchedulerHost(secondDatabase, { onDispatch });

            try {
                await vi.advanceTimersByTimeAsync(300);

                expect(delivered).toStrictEqual(["jobs:run"]);
                await expect(first.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                second.dispose();
            }
        } finally {
            first.dispose();
            firstDatabase.close();
            secondDatabase.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("refuses retry.forever as INVALID_INPUT before persisting or arming the job", async () => {
        expect.assertions(2);

        const database = new Database(":memory:");
        const host = createNodeSchedulerHost(database, { onDispatch: vi.fn<(functionPath: string) => void>() });

        try {
            await expect(host.scheduler.schedule("jobs:run", {}, { retry: { forever: true } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
            await expect(host.scheduler.list?.()).resolves.toHaveLength(0);
        } finally {
            host.dispose();
            database.close();
        }
    });

    it("does not let another host's stale timer deliver a retry before its backoff", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const delivered: number[] = [];
        const onDispatch = (): void => {
            delivered.push(Date.now());

            if (delivered.length === 1) {
                throw new Error("first attempt fails");
            }
        };
        const firstDatabase = new Database(path);
        const secondDatabase = new Database(path);
        const first = createNodeSchedulerHost(firstDatabase, { onDispatch });

        try {
            await first.scheduler.schedule("jobs:run", {}, { delayMs: 0, retry: { initialDelayMs: 10_000, maxAttempts: 3 } });

            // Armed for the original time too, so its timer is stale once the first attempt reschedules the row.
            const second = createNodeSchedulerHost(secondDatabase, { onDispatch });

            try {
                await vi.advanceTimersByTimeAsync(1000);

                expect(delivered).toHaveLength(1);

                await vi.advanceTimersByTimeAsync(10_000);

                expect(delivered).toHaveLength(2);
            } finally {
                second.dispose();
            }
        } finally {
            first.dispose();
            firstDatabase.close();
            secondDatabase.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("keeps a claim alive while its handler outlives the lease, so a second host never redelivers it", async () => {
        expect.assertions(2);

        // The lease is 60 s; a fake clock lets the test run three of them without waiting.
        vi.useFakeTimers();

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const delivered: string[] = [];
        let finishHandler: () => void = () => {};
        const handlerFinished = new Promise<void>((resolve) => {
            finishHandler = resolve;
        });
        const firstDatabase = new Database(path);
        const secondDatabase = new Database(path);
        const first = createNodeSchedulerHost(firstDatabase, {
            onDispatch: async (functionPath: string): Promise<void> => {
                delivered.push(`first:${functionPath}`);
                await handlerFinished;
            },
        });

        try {
            await first.scheduler.schedule("jobs:run", {}, { delayMs: 0 });

            // Constructed after the schedule, so it holds a timer on the same pending row.
            const second = createNodeSchedulerHost(secondDatabase, {
                onDispatch: (functionPath: string): void => {
                    delivered.push(`second:${functionPath}`);
                },
            });

            try {
                await vi.advanceTimersByTimeAsync(3 * 60_000);

                expect(delivered).toStrictEqual(["first:jobs:run"]);

                finishHandler();
                await vi.advanceTimersByTimeAsync(0);

                await expect(first.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                second.dispose();
            }
        } finally {
            first.dispose();
            firstDatabase.close();
            secondDatabase.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("hands the handler the job's due time so the shard can measure its lag", async () => {
        expect.assertions(1);

        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);

        const database = new Database(":memory:");
        const due: number[] = [];
        const host = createNodeSchedulerHost(database, {
            onDispatch: (_functionPath, _args, job): void => {
                due.push(job.scheduledFor);
            },
        });

        try {
            await host.scheduler.schedule("jobs:run", {}, { delayMs: 500 });
            await vi.advanceTimersByTimeAsync(500);

            expect(due).toStrictEqual([1_700_000_000_500]);
        } finally {
            host.dispose();
            database.close();
        }
    });

    it("retries a claim that failed with the database busy instead of stranding the job", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const delivered: string[] = [];
        // No busy wait, so the claim throws SQLITE_BUSY at once while the other connection holds the write lock.
        const database = new Database(path, { timeout: 0 });
        const otherProcess = new Database(path);
        const host = createNodeSchedulerHost(database, {
            onDispatch: (functionPath: string): void => {
                delivered.push(functionPath);
            },
        });

        try {
            await host.scheduler.schedule("jobs:run", {}, { delayMs: 50 });

            otherProcess.exec("BEGIN IMMEDIATE");

            await vi.advanceTimersByTimeAsync(100);

            expect(delivered).toStrictEqual([]);

            otherProcess.exec("COMMIT");

            await vi.advanceTimersByTimeAsync(5000);

            expect(delivered).toStrictEqual(["jobs:run"]);
        } finally {
            host.dispose();
            database.close();
            otherProcess.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("retries the claim-column migration while another process holds the file's write lock", async () => {
        expect.assertions(2);

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const database = new Database(path);

        database.exec(
            `CREATE TABLE _lunora_scheduler_jobs (
                id TEXT PRIMARY KEY,
                function_path TEXT NOT NULL,
                args BLOB NOT NULL,
                scheduled_for INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                retry BLOB,
                state TEXT NOT NULL DEFAULT 'pending'
            )`,
        );

        // The first ALTER meets a write lock held by a process that is still migrating an older build.
        const exec = database.exec.bind(database);
        let locked = 1;

        database.exec = (source: string) => {
            if (source.includes("ADD COLUMN claimed_at") && locked > 0) {
                locked -= 1;

                throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
            }

            return exec(source);
        };

        try {
            const host = createNodeSchedulerHost(database);

            host.dispose();

            expect(locked).toBe(0);
            expect(
                database
                    .prepare<[], { name: string }>("PRAGMA table_info(_lunora_scheduler_jobs)")
                    .all()
                    .map((column) => column.name),
            ).toContain("claimed_at");
        } finally {
            database.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("starts when another process adds the claim column between its check and its ALTER", async () => {
        expect.assertions(1);

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const firstDatabase = new Database(path);
        const secondDatabase = new Database(path);

        // The table as it was before the claim lease existed.
        firstDatabase.exec(
            `CREATE TABLE _lunora_scheduler_jobs (
                id TEXT PRIMARY KEY,
                function_path TEXT NOT NULL,
                args BLOB NOT NULL,
                scheduled_for INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                retry BLOB,
                state TEXT NOT NULL DEFAULT 'pending'
            )`,
        );

        // The other process wins the race: it runs the same ALTER just after
        // this one checked for the column and just before this one runs it.
        const exec = secondDatabase.exec.bind(secondDatabase);

        secondDatabase.exec = (source: string) => {
            if (source.includes("ADD COLUMN claimed_at")) {
                firstDatabase.exec(source);
            }

            return exec(source);
        };

        try {
            const host = createNodeSchedulerHost(secondDatabase);

            try {
                await host.scheduler.schedule("jobs:run", {}, { delayMs: 60_000 });

                await expect(host.scheduler.list?.()).resolves.toHaveLength(1);
            } finally {
                host.dispose();
            }
        } finally {
            firstDatabase.close();
            secondDatabase.close();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    /**
     * The scheduler's timers share the shard host's connection but not its
     * transaction lock, so a statement they run while a mutation holds `BEGIN`
     * joins that transaction. These open one through the shard host, let the
     * scheduler's timer come due inside it, roll it back, and check that the job
     * is still delivered exactly once and then settled.
     */
    describe("with another task's transaction open on the shared connection", () => {
        const rolledBack = (shard: ReturnType<typeof createNodeShardHost>, during: () => Promise<void>): Promise<void> =>
            shard.host.transaction(async () => {
                await during();

                throw new Error("rolled back");
            });

        it("does not claim a job inside the transaction, so its rollback cannot strand it", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const delivered: string[] = [];
            const shard = createNodeShardHost();
            const host = createNodeSchedulerHost(shard.database, {
                onDispatch: (functionPath: string): void => {
                    delivered.push(functionPath);
                },
            });
            let deliveredDuringTransaction: string[] = [];

            try {
                await host.scheduler.schedule("jobs:run", {}, { delayMs: 10 });

                await expect(
                    rolledBack(shard, async () => {
                        await vi.advanceTimersByTimeAsync(50);
                        deliveredDuringTransaction = [...delivered];
                    }),
                ).rejects.toThrow("rolled back");

                await vi.advanceTimersByTimeAsync(50);

                expect(deliveredDuringTransaction).toStrictEqual([]);
                expect(delivered).toStrictEqual(["jobs:run"]);
                await expect(host.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                host.dispose();
                shard.dispose();
            }
        });

        it("does not renew a lease inside the transaction, so settlement still matches the claim", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const delivered: string[] = [];
            let finishHandler: () => void = () => {};
            const shard = createNodeShardHost();
            const host = createNodeSchedulerHost(shard.database, {
                onDispatch: async (functionPath: string): Promise<void> => {
                    delivered.push(functionPath);
                    await new Promise<void>((resolve) => {
                        finishHandler = resolve;
                    });
                },
            });

            try {
                await host.scheduler.schedule("jobs:run", {}, { delayMs: 0 });
                await vi.advanceTimersByTimeAsync(10);

                // The renewal tick (a third of the 60 s lease) comes due inside the transaction.
                await expect(
                    rolledBack(shard, async () => {
                        await vi.advanceTimersByTimeAsync(25_000);
                    }),
                ).rejects.toThrow("rolled back");

                finishHandler();
                await vi.advanceTimersByTimeAsync(100);

                expect(delivered).toStrictEqual(["jobs:run"]);
                await expect(host.scheduler.list?.()).resolves.toHaveLength(0);

                // Settled under the claim it took: nothing left pending for a later host to redeliver.
                expect(shard.database.prepare("SELECT state, claimed_at FROM _lunora_scheduler_jobs").all()).toStrictEqual([
                    { claimed_at: null, state: "succeeded" },
                ]);
            } finally {
                host.dispose();
                shard.dispose();
            }
        });

        it("does not settle a delivered job inside the transaction, so its rollback cannot restore the row", async () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const delivered: string[] = [];
            let finishHandler: () => void = () => {};
            const shard = createNodeShardHost();
            const host = createNodeSchedulerHost(shard.database, {
                onDispatch: async (functionPath: string): Promise<void> => {
                    delivered.push(functionPath);
                    await new Promise<void>((resolve) => {
                        finishHandler = resolve;
                    });
                },
            });

            try {
                await host.scheduler.schedule("jobs:run", {}, { delayMs: 0 });
                await vi.advanceTimersByTimeAsync(10);

                // The handler finishes while the transaction is open.
                await expect(
                    rolledBack(shard, async () => {
                        finishHandler();
                        await vi.advanceTimersByTimeAsync(50);
                    }),
                ).rejects.toThrow("rolled back");

                await vi.advanceTimersByTimeAsync(100);

                expect(delivered).toStrictEqual(["jobs:run"]);
                await expect(host.scheduler.list?.()).resolves.toHaveLength(0);
            } finally {
                host.dispose();
                shard.dispose();
            }
        });
    });
});
