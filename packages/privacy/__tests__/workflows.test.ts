import { describe, expect, it } from "vitest";

import { eu } from "../src/eu";
import type { DataPort } from "../src/ports";
import { durableStep, memoryData, memoryFiles, memoryRequests, setup, SUBJECT, throughJson } from "./harness";

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

    it("keeps its own live archive when the ready step is retried after its claim landed", async () => {
        const store = memoryRequests();
        let loseResponse = true;
        let staleRead = false;
        const flaky = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const claimed = await store.claim(id, from, patch);

                // The ready claim commits, but its answer is lost, so the host retries the step.
                if (patch.status === "ready" && claimed && loseResponse) {
                    loseResponse = false;
                    staleRead = true;

                    throw new Error("connection reset");
                }

                return claimed;
            },
            get: async (id: string) => {
                const row = await store.get(id);

                // The retry's first read is served from a replica that has not seen the claim yet.
                if (staleRead && row !== undefined) {
                    staleRead = false;

                    return { ...row, status: "processing" as const };
                }

                return row;
            },
        };
        const { files, privacy, runExportWorkflow } = setup({ store: flaky });
        const opened = await privacy.requestExport();

        await runExportWorkflow(opened.id, durableStep().step);

        const storageKey = store.rows.get(opened.id)?.storageKey;

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(storageKey === undefined ? false : files.files.has(storageKey)).toBe(true);
    });

    it("advertises no archive when the export was expired before the retried ready step", async () => {
        const store = memoryRequests();
        const files = memoryFiles();
        let loseResponse = true;
        let staleRead = false;
        const flaky = {
            ...store,
            get: async (id: string) => {
                const row = await store.get(id);

                // The retry's first read is served from a replica that has not seen the expiry yet.
                if (staleRead && row !== undefined) {
                    staleRead = false;

                    return { ...row, status: "processing" as const };
                }

                return row;
            },
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const claimed = await store.claim(id, from, patch);

                // The ready claim commits and its answer is lost; an erasure then expires the export and removes the archive.
                if (patch.status === "ready" && claimed && loseResponse) {
                    loseResponse = false;
                    staleRead = true;

                    const row = store.rows.get(id);

                    await Promise.all([...files.files.keys()].map(async (key) => files.delete(key)));
                    store.rows.set(id, { ...row!, status: "expired" });

                    throw new Error("connection reset");
                }

                return claimed;
            },
        };
        const { privacy, runExportWorkflow } = setup({ files, store: flaky });
        const opened = await privacy.requestExport();
        const results = new Map<string, unknown>();
        const { step } = durableStep();

        await runExportWorkflow(opened.id, {
            ...step,
            do: async (name, run) => {
                const result = await step.do(name, run);

                results.set(name, result);

                return result;
            },
        });

        // The step's own answer is the wrapper (read from the stale replica), and its value is what the callback returned.
        expect(results.get("ready")).toStrictEqual({ status: "processing", value: { status: "expired" } });
        expect(store.rows.get(opened.id)?.status).toBe("expired");
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

        // The load step carries the request's id, status and grace end, and never the subject.
        expect(results[0]).toStrictEqual({ erasureGraceUntil: opened.erasureGraceUntil?.toISOString(), id: opened.id, status: "grace", type: "erasure" });
        expect(JSON.stringify(results)).not.toContain(SUBJECT.subjectId);
    });

    it("runs the export handler to ready", async () => {
        const { privacy, runExportWorkflow, store } = setup({ presets: [eu()] });
        const opened = await privacy.requestExport();

        await runExportWorkflow(opened.id, durableStep().step);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });
});

describe("an audit event whose write response is lost", () => {
    /** A store whose first `addEvent` of each request and kind commits and then throws, as a dropped response does. */
    const droppingResponses = (store: ReturnType<typeof memoryRequests>, armed: { on: boolean }) => {
        const dropped = new Set<string>();

        return {
            ...store,
            addEvent: async (requestId: string, at: Date, kind: string, detail?: string) => {
                await store.addEvent(requestId, at, kind, detail);

                if (armed.on && !dropped.has(`${requestId}:${kind}`)) {
                    dropped.add(`${requestId}:${kind}`);

                    throw new Error("connection reset");
                }
            },
        };
    };

    it("is written once when the export workflow retries the step", async () => {
        const armed = { on: false };
        const store = memoryRequests();
        const { privacy, runExportWorkflow } = setup({ store: droppingResponses(store, armed) });
        const opened = await privacy.requestExport();

        armed.on = true;
        await runExportWorkflow(opened.id, durableStep().step);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(store.events).toStrictEqual([`${opened.id}:received`, `${opened.id}:processing`, `${opened.id}:ready`]);
    });

    it("is written once when the failing step is retried", async () => {
        const armed = { on: false };
        const store = memoryRequests();
        const { privacy, runExportWorkflow } = setup({ data: failingCollect(), store: droppingResponses(store, armed) });
        const opened = await privacy.requestExport();

        armed.on = true;
        await runExportWorkflow(opened.id, durableStep().step);

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(store.events).toStrictEqual([`${opened.id}:received`, `${opened.id}:processing`, `${opened.id}:failed`]);
    });

    it("is written once for the erasure and for each export it expires or fails", async () => {
        const armed = { on: false };
        const store = memoryRequests();
        const { privacy, runErasureWorkflow, runExportWorkflow } = setup({ erasure: { graceDays: 0 }, store: droppingResponses(store, armed) });
        const ready = await privacy.requestExport();

        await runExportWorkflow(ready.id, durableStep().step);

        const erasure = await privacy.requestErasure();

        // A second, unfinished export of the subject: the erasure fails it in its complete step.
        store.rows.set("queued", { ...ready, id: "queued", status: "received" });
        store.events.length = 0;
        armed.on = true;
        await runErasureWorkflow(erasure.id, durableStep().step);

        expect([...store.rows.values()].map((row) => `${row.id}:${row.status}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
            [`${ready.id}:expired`, `${erasure.id}:completed`, "queued:failed"].toSorted((a, b) => a.localeCompare(b)),
        );
        expect(store.events.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
            [`${erasure.id}:processing`, `${erasure.id}:completed`, `${ready.id}:expired`, "queued:failed"].toSorted((a, b) => a.localeCompare(b)),
        );
    });
});
