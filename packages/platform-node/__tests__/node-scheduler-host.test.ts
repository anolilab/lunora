import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeSchedulerHost } from "../src/node-scheduler-host";

describe("createNodeSchedulerHost", () => {
    afterEach(() => {
        vi.useRealTimers();
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
});
