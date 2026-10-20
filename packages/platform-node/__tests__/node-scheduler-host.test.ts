import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createNodeSchedulerHost } from "../src/node-scheduler-host";

describe("createNodeSchedulerHost", () => {
    it("delivers a pending job once when two hosts share one database file", async () => {
        expect.assertions(2);

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
                await new Promise((resolve) => {
                    setTimeout(resolve, 300);
                });

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

    it("keeps the claim while a handler outlives the lease, so a second host does not dispatch it again", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const directory = mkdtempSync(join(tmpdir(), "lunora-scheduler-"));
        const path = join(directory, "scheduler.sqlite3");
        const firstDispatches: string[] = [];
        const secondDispatches: string[] = [];
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstDatabase = new Database(path);
        const secondDatabase = new Database(path);
        const first = createNodeSchedulerHost(firstDatabase, {
            onDispatch: async (functionPath) => {
                firstDispatches.push(functionPath);
                await gate;
            },
        });

        try {
            await first.scheduler.schedule("jobs:slow", {}, { delayMs: 10 });
            await vi.advanceTimersByTimeAsync(10);

            const second = createNodeSchedulerHost(secondDatabase, {
                onDispatch: (functionPath) => {
                    secondDispatches.push(functionPath);
                },
            });

            try {
                // Well past the 60 s claim lease while the first handler is still running.
                await vi.advanceTimersByTimeAsync(150_000);

                expect(firstDispatches).toStrictEqual(["jobs:slow"]);
                expect(secondDispatches).toStrictEqual([]);

                release();
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
            vi.useRealTimers();
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
