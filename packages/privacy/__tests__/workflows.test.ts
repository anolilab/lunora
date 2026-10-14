import { describe, expect, it } from "vitest";

import { eu } from "../src/eu";
import type { DataPort } from "../src/ports";
import { durableStep, memoryData, NOW, setup, throughJson } from "./harness";

const failingCollect = (): DataPort => {
    return {
        ...memoryData(),
        collect: async () => {
            throw new Error("disk full");
        },
    };
};

describe("exportHandler", () => {
    it("marks the request ready and stores the archive", async () => {
        const { files, privacy, runExportWorkflow, store } = setup({ presets: [eu()] });
        const opened = await privacy.requestExport();

        await runExportWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect([...files.files.keys()].some((key) => key.endsWith("export.zip"))).toBe(true);
    });

    it("retries a crashed step on its own, and a replay runs no finished step again", async () => {
        const { privacy, runExportWorkflow, store } = setup({ presets: [eu()] });
        const opened = await privacy.requestExport();
        const { runs, step } = durableStep({ failOnce: "assemble" });

        await runExportWorkflow(opened.id, step);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect([...runs.entries()].filter(([, count]) => count > 1)).toStrictEqual([["assemble", 2]]);

        // The host replays the instance from the top: every step result comes from the store.
        const before = new Map(runs);

        await runExportWorkflow(opened.id, step);

        expect(runs).toStrictEqual(before);
        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });

    it("marks the request failed and records why when a collect step throws", async () => {
        const { privacy, runExportWorkflow, store } = setup({ data: failingCollect(), presets: [eu()] });
        const opened = await privacy.requestExport();

        await runExportWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(store.events).toContain(`${opened.id}:failed`);
    });
});

describe("erasureHandler", () => {
    it("waits out the grace, then erases every table and completes", async () => {
        const { privacy, rows, runErasureWorkflow, store } = setup({ presets: [eu()], rows: { goals: 150, tasks: 40 } });
        const opened = await privacy.requestErasure();
        const { names, step } = durableStep();

        await runErasureWorkflow(opened.id, step);

        expect(names.indexOf("sleep:grace")).toBeLessThan(names.findIndex((name) => name.startsWith("erase:")));
        expect(rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(store.rows.get(opened.id)?.status).toBe("completed");
    });

    it("stops without erasing when the subject cancels during the grace", async () => {
        const { privacy, rows, runErasureWorkflow, store } = setup({ presets: [eu()], rows: { goals: 150, tasks: 40 } });
        const opened = await privacy.requestErasure();
        const { step } = durableStep({
            onSleep: () => {
                // The subject cancels while the workflow sleeps.
                store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "cancelled" });
            },
        });

        await runErasureWorkflow(opened.id, step);

        expect(rows).toStrictEqual({ goals: 150, tasks: 40 });
        expect(store.rows.get(opened.id)?.status).toBe("cancelled");
    });
});

describe("step results survive a JSON round trip", () => {
    it("sleeps until the grace end as a Date and still completes the erasure", async () => {
        const { privacy, rows, runErasureWorkflow, store } = setup({ presets: [eu()], rows: { goals: 150, tasks: 40 } });
        const opened = await privacy.requestErasure();
        const { sleeps, step } = durableStep();

        await runErasureWorkflow(opened.id, step);

        expect(sleeps).toHaveLength(1);
        expect(sleeps[0]).toBeInstanceOf(Date);
        expect(sleeps[0]?.getTime()).toBe(opened.erasureGraceUntil?.getTime());
        expect(rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(store.rows.get(opened.id)?.status).toBe("completed");
    });

    it("returns step results that are plain JSON, with dates as ISO strings", async () => {
        const { privacy, runErasureWorkflow } = setup({ presets: [eu()] });
        const opened = await privacy.requestErasure();
        const results: unknown[] = [];

        await runErasureWorkflow(opened.id, {
            ...durableStep().step,
            do: async (_name, run) => {
                const result = await run();

                results.push(result);

                return result;
            },
        });

        for (const result of results) {
            expect(result).toStrictEqual(throughJson(result));
        }

        expect(results[0]).toMatchObject({ erasureGraceUntil: opened.erasureGraceUntil?.toISOString(), receivedAt: NOW.toISOString() });
    });

    it("runs the export handler to ready", async () => {
        const { privacy, runExportWorkflow, store } = setup({ presets: [eu()] });
        const opened = await privacy.requestExport();

        await runExportWorkflow(opened.id, durableStep().step);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });
});
