import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveShard } from "@lunora/platform";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodePlatform } from "../src/node-platform";

const MINUTE = 60 * 1000;

describe("createNodePlatform declared crons", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-node-crons-"));
        vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });
    });

    afterEach(() => {
        vi.useRealTimers();
        rmSync(directory, { force: true, recursive: true });
    });

    const dispatchSpy = () => vi.fn<(functionPath: string, args: Record<string, unknown>) => void>();

    it("fires every job of the generated LUNORA_CRONS map, keeping same-function jobs apart by name", async () => {
        expect.assertions(1);

        const onDispatch = dispatchSpy();
        const platform = createNodePlatform({
            crons: {
                "* * * * *": [
                    { args: { region: "eu" }, functionPath: "billing:sweep", name: "sweep-eu" },
                    { args: { region: "us" }, functionPath: "billing:sweep", name: "sweep-us" },
                ],
            },
            onDispatch: async (functionPath, args) => {
                onDispatch(functionPath, args);
            },
            path: join(directory, "shard.sqlite3"),
        });

        try {
            await vi.advanceTimersByTimeAsync(MINUTE);

            expect(onDispatch.mock.calls).toStrictEqual(
                expect.arrayContaining([
                    ["billing:sweep", { region: "eu" }],
                    ["billing:sweep", { region: "us" }],
                ]),
            );
        } finally {
            platform.close();
        }
    });

    it("starts no cron tick or job that comes due during a drain, and fires both after a restart", async () => {
        expect.assertions(3);

        const path = join(directory, "shard.sqlite3");
        const crons = { "* * * * *": [{ args: {}, functionPath: "reports:tick", name: "tick" }] };
        const during = dispatchSpy();
        const first = createNodePlatform({
            crons,
            onDispatch: async (functionPath, args) => {
                during(functionPath, args);
            },
            path,
        });
        let release: () => void = () => {};

        await first.scheduler.schedule("reports:once", {}, { delayMs: 10_000 });
        // Host work that holds the drain open while both come due.
        first.shard.waitUntil?.(
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        );

        const drained = first.drain({ timer: () => () => {} });

        await vi.advanceTimersByTimeAsync(2 * MINUTE);

        expect(during).not.toHaveBeenCalled();

        release();
        await drained;
        first.close();

        const after = dispatchSpy();
        const second = createNodePlatform({
            crons,
            onDispatch: async (functionPath, args) => {
                after(functionPath, args);
            },
            path,
        });

        try {
            await vi.advanceTimersByTimeAsync(MINUTE);

            // Neither was lost: the job's row and the cron's declaration were kept, and both fire once the server is back.
            expect(after).toHaveBeenCalledWith("reports:once", {});
            expect(after).toHaveBeenCalledWith("reports:tick", {});
        } finally {
            second.close();
        }
    });

    it("keeps jobs, crons and alarms running when a drain is refused for a bad timeout", async () => {
        expect.assertions(4);

        const onDispatch = dispatchSpy();
        const fired: string[] = [];
        const platform = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:tick", name: "tick" }] },
            // Optional: the platform's own host calls it with no shard, a registry shard with one.
            onAlarm: (shard?: { shardKey: string }) => {
                fired.push(shard?.shardKey ?? "platform");
            },
            onDispatch: async (functionPath, args) => {
                onDispatch(functionPath, args);
            },
            onFetch: async (_request, shard) => {
                await shard.shard.alarms.set(Date.now() + 1000);

                return new Response("armed");
            },
            path: join(directory, "shard.sqlite3"),
        });

        try {
            await resolveShard(platform.directory, "a").fetch(new Request("https://shard.internal/rpc"));
            await platform.scheduler.schedule("reports:once", {}, { delayMs: 10_000 });

            await expect(platform.drain({ timeoutMs: -1 })).rejects.toThrow("a drain timeoutMs must be a whole number of milliseconds");

            await vi.advanceTimersByTimeAsync(MINUTE);

            // Refused before anything was stopped, so everything still fires.
            expect(onDispatch).toHaveBeenCalledWith("reports:once", {});
            expect(onDispatch).toHaveBeenCalledWith("reports:tick", {});
            expect(fired).toStrictEqual(["a"]);
        } finally {
            platform.close();
        }
    });

    it("stops firing a cron the app no longer declares after a restart", async () => {
        expect.assertions(2);

        const path = join(directory, "shard.sqlite3");
        const first = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:old", name: "old" }] },
            onDispatch: () => undefined,
            path,
        });

        first.close();

        const onDispatch = dispatchSpy();
        const second = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:new", name: "new" }] },
            onDispatch: async (functionPath, args) => {
                onDispatch(functionPath, args);
            },
            path,
        });

        try {
            await vi.advanceTimersByTimeAsync(MINUTE);

            expect(onDispatch).toHaveBeenCalledWith("reports:new", {});
            expect(onDispatch).not.toHaveBeenCalledWith("reports:old", expect.anything());
        } finally {
            second.close();
        }
    });

    it("refuses declared crons when neither onFetch nor onDispatch can deliver them", () => {
        expect.assertions(2);

        expect(() =>
            createNodePlatform({
                crons: { "* * * * *": [{ args: {}, functionPath: "reports:tick", name: "tick" }] },
                path: join(directory, "shard.sqlite3"),
            }),
        ).toThrow(/onFetch/u);

        // An empty map declares nothing to deliver, and is how a cron-free app clears stale rows.
        expect(() => {
            createNodePlatform({ crons: {}, path: join(directory, "shard.sqlite3") }).close();
        }).not.toThrow();
    });

    it("refuses two declared jobs with the same name instead of dropping one", () => {
        expect.assertions(1);

        expect(() =>
            createNodePlatform({
                crons: {
                    "0 3 * * *": [{ args: {}, functionPath: "reports:a", name: "nightly" }],
                    "0 4 * * *": [{ args: {}, functionPath: "reports:b", name: "nightly" }],
                },
                onDispatch: () => undefined,
                path: join(directory, "shard.sqlite3"),
            }),
        ).toThrow(/"nightly"/u);
    });

    const cronKeys = (path: string): string[] => {
        const database = new Database(path, { readonly: true });

        try {
            return database
                .prepare<[], { key: string }>("SELECT key FROM _lunora_scheduler_crons ORDER BY key")
                .all()
                .map((row) => row.key);
        } finally {
            database.close();
        }
    };

    it("lets a second process without crons open the file without stopping the server's declared crons", async () => {
        expect.assertions(4);

        const path = join(directory, "shard.sqlite3");
        const server = dispatchSpy();
        const serverPlatform = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:declared", name: "declared" }] },
            onDispatch: async (functionPath, args) => {
                server(functionPath, args);
            },
            path,
        });
        // An admin script on the same file, alive across the server's ticks.
        const script = dispatchSpy();
        const scriptPlatform = createNodePlatform({
            onDispatch: async (functionPath, args) => {
                script(functionPath, args);
            },
            path,
        });

        try {
            await vi.advanceTimersByTimeAsync(2 * MINUTE);

            expect(cronKeys(path)).toStrictEqual(["declared:declared"]);
            // Both ticks: the server's re-arm still finds its row after the script opened the file.
            expect(server).toHaveBeenCalledTimes(2);
            expect(script).not.toHaveBeenCalled();
        } finally {
            scriptPlatform.close();
            serverPlatform.close();
        }

        expect(cronKeys(path)).toStrictEqual(["declared:declared"]);
    });

    it("fires nothing declared after a restart without crons, while cron() rows still fire", async () => {
        expect.assertions(3);

        const path = join(directory, "shard.sqlite3");
        const first = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:declared", name: "declared" }] },
            onDispatch: () => undefined,
            path,
        });

        await first.scheduler.cron?.("* * * * *", "reports:dynamic", {});
        first.close();

        const onDispatch = dispatchSpy();
        const second = createNodePlatform({
            onDispatch: async (functionPath, args) => {
                onDispatch(functionPath, args);
            },
            path,
        });

        try {
            await vi.advanceTimersByTimeAsync(MINUTE);

            expect(onDispatch).not.toHaveBeenCalledWith("reports:declared", expect.anything());
            expect(onDispatch).toHaveBeenCalledWith("reports:dynamic", {});
        } finally {
            second.close();
        }

        // Ignored, not deleted: the declared set belongs to whichever process passes `crons`.
        expect(cronKeys(path)).toStrictEqual(["* * * * * reports:dynamic", "declared:declared"]);
    });

    it("logs when another process passing crons removes a job the server declared", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const path = join(directory, "shard.sqlite3");
        const server = dispatchSpy();
        const serverPlatform = createNodePlatform({
            crons: { "* * * * *": [{ args: {}, functionPath: "reports:declared", name: "declared" }] },
            onDispatch: async (functionPath, args) => {
                server(functionPath, args);
            },
            path,
        });

        try {
            // Another process that does manage the set declares none.
            createNodePlatform({ crons: {}, path }).close();
            await vi.advanceTimersByTimeAsync(2 * MINUTE);

            // The armed timer re-reads its row before dispatching, so the removed job does not run once more.
            expect(server).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toContain('job "declared"');
        } finally {
            serverPlatform.close();
            warn.mockRestore();
        }
    });

    it("refuses a job whose schedule parses but never occurs, naming the job", () => {
        expect.assertions(1);

        expect(() =>
            createNodePlatform({
                crons: { "0 0 31 4,6,9,11 *": [{ args: {}, functionPath: "reports:never", name: "thirty-first" }] },
                onDispatch: () => undefined,
                path: join(directory, "shard.sqlite3"),
            }),
        ).toThrow(/"thirty-first".*never occurs/u);
    });

    it("refuses a workflow-targeted cron at construction instead of never firing it", () => {
        expect.assertions(1);

        expect(() =>
            createNodePlatform({
                crons: { "0 3 * * *": [{ args: {}, name: "nightly", workflow: "NightlyWorkflow" }] },
                path: join(directory, "shard.sqlite3"),
            }),
        ).toThrow(/NightlyWorkflow/u);
    });
});
