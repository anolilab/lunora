import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    it("stops firing a cron the app no longer declares after a restart", async () => {
        expect.assertions(2);

        const path = join(directory, "shard.sqlite3");
        const first = createNodePlatform({ crons: { "* * * * *": [{ args: {}, functionPath: "reports:old", name: "old" }] }, path });

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
