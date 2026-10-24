import { decodeWire } from "@lunora/wire";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import type { DataPort } from "../src/ports";
import type { MemoryFiles } from "./harness";
import { codeOf, exportFileOf, memoryFiles, memoryRequests, setup } from "./harness";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: { omit: ["activeCycle"] } },
});
const quiesced = defineDataset("scheduler", {
    legalBasis: "contract",
    origin: "derived",
    phase: "quiesce",
    purpose: "Scheduled work",
    tables: { jobs: {} },
});

/** Records every call, so a test can check order and content. */
const memoryData = (initial: Record<string, number>, options: { failCollect?: boolean } = {}) => {
    const rows: Record<string, number> = { ...initial };
    const calls: string[] = [];
    const port: DataPort = {
        collect: async (dataset) => {
            calls.push(`collect:${dataset.id}`);

            if (options.failCollect === true) {
                throw new Error("disk full");
            }

            return Object.fromEntries(dataset.tableNames.map((table) => [table, [{ id: `${table}-1` }]]));
        },
        eraseBatch: async (dataset) => {
            calls.push(`erase:${dataset.id}`);
            let hasMore = false;

            for (const table of dataset.tableNames) {
                rows[table] = Math.max(0, (rows[table] ?? 0) - 100);
                hasMore = hasMore || rows[table] > 0;
            }

            return { hasMore };
        },
        remaining: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, rows[table] ?? 0])),
    };

    return { calls, port };
};

const NO_GRACE = { graceDays: 0 };

describe("runExport", () => {
    it("exports a bigint and a bytes column, writing each as the wire codec's tagged leaf", async () => {
        const row = { blob: new Uint8Array([0, 1, 254, 255]).buffer, id: 12_345_678_901_234_567_890n };
        const data: DataPort = {
            ...memoryData({}).port,
            collect: async () => {
                return { goals: [], tasks: [row] };
            },
        };
        const { files, privacy } = setup({ data });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toMatchObject({ status: "ready" });

        const text = new TextDecoder().decode(unzipSync(files.files.get(exportFileOf(files, "r1", "export.zip")) as Uint8Array)["data/tasks/tasks.json"]);

        expect(text).toContain('"12345678901234567890"');
        expect(text).toContain('"AAH+/w=="');
        expect(decodeWire(JSON.parse(text))).toStrictEqual([row]);
    });

    it("collects every dataset and stores the archive and the summary", async () => {
        const { files, privacy } = setup({ data: memoryData({}).port });
        const opened = await privacy.requestExport();
        const outcome = await privacy.runExport(opened.id);

        expect(outcome).toMatchObject({ archiveKey: exportFileOf(files, "r1", "export.zip"), status: "ready" });
        expect([...files.files.keys()]).toStrictEqual(
            expect.arrayContaining([exportFileOf(files, "r1", "export.zip"), exportFileOf(files, "r1", "summary.pdf")]),
        );
    });

    it("writes the table rows and a manifest that tags each dataset's articles", async () => {
        const { files, privacy } = setup({ data: memoryData({}).port });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        const extracted = unzipSync(files.files.get(exportFileOf(files, "r1", "export.zip")) as Uint8Array);
        const manifest = JSON.parse(new TextDecoder().decode(extracted["manifest.json"])) as { datasets: { articles: string[]; id: string }[] };

        expect(Object.keys(extracted).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "data/tasks/goals.json",
            "data/tasks/tasks.json",
            "manifest.json",
        ]);
        expect(manifest.datasets[0]).toMatchObject({ articles: ["15", "20"], id: "tasks" });
    });

    it("marks the request failed, and says why, when collection throws", async () => {
        const { files, privacy, store } = setup({ data: memoryData({}, { failCollect: true }).port });
        const opened = await privacy.requestExport();
        const outcome = await privacy.runExport(opened.id);

        expect(outcome.status).toBe("failed");
        expect(store.events).toContain("r1:failed");
        expect(files.files.size).toBe(0);
    });

    it("records the error's code on the failed event, never its message", async () => {
        const store = memoryRequests();
        const details: string[] = [];
        const recording = {
            ...store,
            addEvent: async (requestId: string, at: Date, kind: string, detail?: string) => {
                details.push(detail ?? "");
                await store.addEvent(requestId, at, kind, detail);
            },
        };
        const { privacy } = setup({ data: memoryData({}, { failCollect: true }).port, store: recording });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        expect(details.join("|")).toContain("INTERNAL");
        expect(details.join("|")).not.toContain("disk full");
    });

    it("does not start a request a cancel reached between the start read and the claim", async () => {
        const store = memoryRequests();
        let reads: number | undefined;
        const racing = {
            ...store,
            get: async (id: string) => {
                const row = await store.get(id);

                if (reads === undefined) {
                    return row;
                }

                reads += 1;

                // The run reads the load step first and the start second; a cancel lands after the start's read.
                if (reads === 2 && row !== undefined) {
                    store.rows.set(id, { ...row, status: "cancelled" });
                }

                return row;
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, store: racing });
        const opened = await privacy.requestExport();

        reads = 0;

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "cancelled" });
        expect(store.rows.get(opened.id)?.status).toBe("cancelled");
        expect(files.files.size).toBe(0);
    });

    it("stops at the next step when the request leaves processing during the run, instead of writing over it", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const { port } = memoryData({});
        let cancel: () => void = () => undefined;
        const interrupting: DataPort = {
            ...port,
            collect: async (dataset, subjectId) => {
                cancel();

                return port.collect(dataset, subjectId);
            },
        };
        const { files, privacy, store } = setup({ data: interrupting, datasets: [tasks, second] });
        const opened = await privacy.requestExport();

        cancel = () => {
            store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "cancelled" });
        };

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "cancelled" });
        expect(store.rows.get(opened.id)?.status).toBe("cancelled");
        expect([...files.files.keys()].some((key) => key.endsWith("/parts/notes.json"))).toBe(false);
    });

    it("fails rather than finishing under the tombstone key when an erasure completes between two collect steps", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const { port } = memoryData({});
        const collectedFor: string[] = [];
        let erase: () => Promise<unknown> = async () => undefined;
        const interrupting: DataPort = {
            ...port,
            collect: async (dataset, subjectId) => {
                collectedFor.push(subjectId);
                await erase();
                erase = async () => undefined;

                return port.collect(dataset, subjectId);
            },
        };
        const { files, privacy, store } = setup({ data: interrupting, datasets: [tasks, second], erasure: NO_GRACE });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        erase = async () => privacy.runErasure(erasure.id);

        await expect(privacy.runExport(exported.id)).resolves.toStrictEqual({ status: "failed" });
        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect(collectedFor).toStrictEqual(["u1"]);
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("refuses an operator retry of an export an erasure failed, and leaves it failed", async () => {
        const { port } = memoryData({});
        let erase: () => Promise<unknown> = async () => undefined;
        const interrupting: DataPort = {
            ...port,
            collect: async (dataset, subjectId) => {
                await erase();
                erase = async () => undefined;

                return port.collect(dataset, subjectId);
            },
        };
        const { files, operator, privacy, store } = setup({ data: interrupting, erasure: NO_GRACE });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        erase = async () => privacy.runErasure(erasure.id);

        await expect(privacy.runExport(exported.id)).resolves.toStrictEqual({ status: "failed" });
        await expect(codeOf(operator.admin.retry(exported.id))).resolves.toBe("UNPROCESSABLE");
        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("fails a queued export when the subject's erasure completes first, and the export's run publishes nothing", async () => {
        const { calls, port } = memoryData({});
        const { files, privacy, runErasureWorkflow, runExportWorkflow, store } = setup({ data: port, erasure: NO_GRACE });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect(store.events).toContain(`${exported.id}:failed`);

        await runExportWorkflow(exported.id);

        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect(calls.filter((call) => call.startsWith("collect:"))).toStrictEqual([]);
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("leaves another erasure request of the subject open when an erasure completes", async () => {
        const { port } = memoryData({});
        const { privacy, store } = setup({ data: port, erasure: NO_GRACE });
        const first = await privacy.requestErasure();
        // The service refuses a second open erasure, so the store holds one a duplicate or an older run left behind.
        const stranded = [
            { ...first, id: "stranded-received", status: "received" as const },
            { ...first, id: "stranded-grace", status: "grace" as const },
            { ...first, id: "stranded-processing", status: "processing" as const },
        ];

        for (const row of stranded) {
            store.rows.set(row.id, row);
        }

        await privacy.runErasure(first.id);

        expect(store.rows.get(first.id)?.status).toBe("completed");

        for (const row of stranded) {
            expect(store.rows.get(row.id)?.status).toBe(row.status);
            expect(store.events).not.toContain(`${row.id}:failed`);
        }
    });

    it("stops a queued export's run when the erasure already completed, even though the export is still received", async () => {
        const { port } = memoryData({});
        const { privacy, store } = setup({ data: port, erasure: NO_GRACE });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        await privacy.runErasure(erasure.id);
        // The state a queued export is in if the erasure's claim missed it: still received, under the tombstone key.
        store.rows.set(exported.id, { ...exported, status: "received", subjectId: store.rows.get(erasure.id)?.subjectId ?? "" });

        await expect(privacy.runExport(exported.id)).resolves.toStrictEqual({ status: "failed" });
        expect(store.rows.get(exported.id)?.status).toBe("failed");
    });

    it("fails an export that starts between the erasure's read of it and its claim", async () => {
        const store = memoryRequests();
        let started = false;
        const racing = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const row = store.rows.get(id);

                // The export's run claims `processing` just before the erasure's claim from `received` lands.
                if (!started && row?.type === "export" && patch.status === "failed") {
                    started = true;
                    store.rows.set(id, { ...row, status: "processing" });
                }

                return store.claim(id, from, patch);
            },
        };
        const { privacy } = setup({ data: memoryData({}).port, erasure: NO_GRACE, store: racing });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        await expect(privacy.runErasure(erasure.id)).resolves.toMatchObject({ status: "completed" });
        expect(started).toBe(true);
        expect(store.rows.get(exported.id)?.status).toBe("failed");
    });

    it("stays failed, with no archive, when an erasure completes between the ready step's read and its write", async () => {
        const store = memoryRequests();
        let erase: (() => Promise<unknown>) | undefined;
        const beforeReady = async (patch: { readonly status?: string }): Promise<void> => {
            const run = erase;

            if (patch.status === "ready" && run !== undefined) {
                erase = undefined;
                await run();
            }
        };
        const racing = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                await beforeReady(patch);

                return store.claim(id, from, patch);
            },
            update: async (id: string, patch: Parameters<typeof store.update>[1]) => {
                await beforeReady(patch);
                await store.update(id, patch);
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, datasets: [tasks], erasure: NO_GRACE, store: racing });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();

        erase = async () => privacy.runErasure(erasure.id);

        await expect(privacy.runExport(exported.id)).resolves.toStrictEqual({ status: "failed" });
        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect(store.rows.get(exported.id)?.storageKey).toBeUndefined();
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("deletes the archive when the export was failed between the ready step's read and its claim", async () => {
        const store = memoryRequests();
        let failFirst = true;
        const racing = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const row = store.rows.get(id);

                if (patch.status === "ready" && failFirst && row !== undefined) {
                    failFirst = false;
                    store.rows.set(id, { ...row, status: "failed" });
                }

                return store.claim(id, from, patch);
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, store: racing });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "failed" });
        expect([...files.files.keys()].filter((key) => key.startsWith(`${opened.id}/`))).toStrictEqual([]);
    });

    it("keeps the winner's archive when a second run of the same export loses the ready claim", async () => {
        const store = memoryRequests();
        let runWinner: (() => Promise<unknown>) | undefined;
        const racing = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const run = runWinner;

                // The first ready claim is the loser's: the other run finishes and claims ready before it lands.
                if (patch.status === "ready" && run !== undefined) {
                    runWinner = undefined;
                    await run();
                }

                return store.claim(id, from, patch);
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, store: racing });
        const opened = await privacy.requestExport();

        runWinner = async () => privacy.runExport(opened.id);

        const loser = await privacy.runExport(opened.id);
        const winnerKey = store.rows.get(opened.id)?.storageKey;

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(loser).toStrictEqual({ archiveKey: winnerKey, status: "ready" });
        expect(winnerKey === undefined ? false : files.files.has(winnerKey)).toBe(true);
        expect([...files.files.keys()].filter((key) => key.endsWith("/export.zip"))).toStrictEqual([winnerKey]);
    });

    it("deletes its files when another run made the export ready before this run's ready step", async () => {
        const store = memoryRequests();
        const files = memoryFiles();
        let runWinner: (() => Promise<unknown>) | undefined;
        const writing: MemoryFiles = {
            ...files,
            put: async (requestId, file) => {
                const key = await files.put(requestId, file);
                const run = runWinner;

                // The other run finishes while this one is still assembling, so the ready step never runs its callback.
                if (file.name.endsWith("/export.zip") && run !== undefined) {
                    runWinner = undefined;
                    await run();
                }

                return key;
            },
        };
        const { privacy } = setup({ data: memoryData({}).port, files: writing, store });
        const opened = await privacy.requestExport();

        runWinner = async () => privacy.runExport(opened.id);

        const loser = await privacy.runExport(opened.id);
        const winnerKey = store.rows.get(opened.id)?.storageKey;

        expect(loser).toStrictEqual({ archiveKey: winnerKey, status: "ready" });
        expect([...new Set([...files.files.keys()].map((key) => key.split("/")[1]))]).toStrictEqual([winnerKey?.split("/")[1]]);
    });

    it("deletes the part it wrote when another run made the export ready between two collect steps", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const store = memoryRequests();
        const files = memoryFiles();
        let runWinner: (() => Promise<unknown>) | undefined;
        const writing: MemoryFiles = {
            ...files,
            put: async (requestId, file) => {
                const key = await files.put(requestId, file);
                const run = runWinner;

                if (file.name.endsWith("/parts/tasks.json") && run !== undefined) {
                    runWinner = undefined;
                    await run();
                }

                return key;
            },
        };
        const { privacy } = setup({ data: memoryData({}).port, datasets: [tasks, second], files: writing, store });
        const opened = await privacy.requestExport();

        runWinner = async () => privacy.runExport(opened.id);

        await expect(privacy.runExport(opened.id)).resolves.toMatchObject({ status: "ready" });

        const winnerKey = store.rows.get(opened.id)?.storageKey;

        expect([...new Set([...files.files.keys()].map((key) => key.split("/")[1]))]).toStrictEqual([winnerKey?.split("/")[1]]);
    });

    it("deletes the part it wrote when a later collect step finds the request no longer processing", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const store = memoryRequests();
        const files = memoryFiles();
        const writing: MemoryFiles = {
            ...files,
            put: async (requestId, file) => {
                const key = await files.put(requestId, file);
                const row = store.rows.get(requestId);

                // Another run fails the request right after this run wrote its first part.
                if (file.name.endsWith("/parts/tasks.json") && row !== undefined) {
                    store.rows.set(requestId, { ...row, status: "failed" });
                }

                return key;
            },
        };
        const { privacy } = setup({ data: memoryData({}).port, datasets: [tasks, second], files: writing, store });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "failed" });
        expect([...files.files.keys()].filter((key) => key.startsWith(`${opened.id}/`))).toStrictEqual([]);
    });

    it("deletes the part it wrote when a later collect step throws", async () => {
        const second = defineDataset("notes", { legalBasis: "contract", origin: "provided", purpose: "Notes", tables: { notes: {} } });
        const { port } = memoryData({});
        const failing: DataPort = {
            ...port,
            collect: async (dataset, subjectId) => {
                if (dataset.id === "notes") {
                    throw new Error("disk full");
                }

                return port.collect(dataset, subjectId);
            },
        };
        const { files, privacy, store } = setup({ data: failing, datasets: [tasks, second] });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "failed" });
        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${opened.id}/`))).toStrictEqual([]);
    });

    it("keeps the archive of a ready export when the run throws after the ready write", async () => {
        const store = memoryRequests();
        const throwing = {
            ...store,
            addEvent: async (requestId: string, at: Date, kind: string, detail?: string) => {
                if (kind === "ready") {
                    throw new Error("event log unavailable");
                }

                await store.addEvent(requestId, at, kind, detail);
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, store: throwing });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toStrictEqual({ status: "ready" });

        const storageKey = store.rows.get(opened.id)?.storageKey;

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(storageKey === undefined ? false : files.files.has(storageKey)).toBe(true);
    });

    it("never deletes the winner's archive when the loser's status read is stale", async () => {
        const store = memoryRequests();
        let failLoser = true;
        let afterLostClaim: (() => Promise<unknown>) | undefined;
        let runWinner: (() => Promise<unknown>) | undefined;
        const racing = {
            ...store,
            claim: async (id: string, from: Parameters<typeof store.claim>[1], patch: Parameters<typeof store.claim>[2]) => {
                const row = store.rows.get(id);

                // Another run's failure lands first, so the loser's ready claim fails.
                if (patch.status === "ready" && failLoser && row !== undefined) {
                    failLoser = false;
                    store.rows.set(id, { ...row, status: "failed" });
                    afterLostClaim = runWinner;
                }

                return store.claim(id, from, patch);
            },
            get: async (id: string) => {
                const row = await store.get(id);
                const run = afterLostClaim;

                // The loser reads `failed`; an operator retry then runs to ready before the loser acts on that read.
                if (run !== undefined && row !== undefined) {
                    afterLostClaim = undefined;
                    store.rows.set(id, { ...row, status: "processing" });
                    await run();
                }

                return row;
            },
        };
        const { files, privacy } = setup({ data: memoryData({}).port, store: racing });
        const opened = await privacy.requestExport();

        runWinner = async () => privacy.runExport(opened.id);

        await privacy.runExport(opened.id);

        const winnerKey = store.rows.get(opened.id)?.storageKey;

        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(winnerKey === undefined ? false : files.files.has(winnerKey)).toBe(true);
    });

    it("finishes a failed export's cleanup when the erasure's complete step is retried", async () => {
        const store = memoryRequests();
        const files = memoryFiles();
        let failDelete = true;
        const flaky: MemoryFiles = {
            ...files,
            delete: async (key) => {
                if (failDelete && key.includes("/late/")) {
                    failDelete = false;

                    throw new Error("storage unavailable");
                }

                await files.delete(key);
            },
        };
        const { privacy, runErasureWorkflow } = setup({ erasure: NO_GRACE, files: flaky, store });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();
        const { listForSubject } = store;
        let lists = 0;

        store.rows.set(exported.id, { ...exported, status: "processing" });

        // The export writes a part after the erasure's files step and before its complete step lists the requests.
        store.listForSubject = async (subjectId) => {
            lists += 1;

            if (lists === 2) {
                await files.put(exported.id, { data: "{}", name: "late/parts/tasks.json" });
            }

            return listForSubject(subjectId);
        };

        await runErasureWorkflow(erasure.id);

        expect(failDelete).toBe(false);
        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(store.rows.get(exported.id)?.status).toBe("failed");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("leaves a ready export ready, with its archive, when the erasure cannot delete the archive, and expires it on the retry", async () => {
        const files = memoryFiles();
        let failDelete = true;
        const flaky: MemoryFiles = {
            ...files,
            delete: async (key) => {
                if (failDelete && key.endsWith("/export.zip")) {
                    throw new Error("storage unavailable");
                }

                await files.delete(key);
            },
        };
        const { operator, privacy, store } = setup({ data: memoryData({}).port, datasets: [tasks], erasure: NO_GRACE, files: flaky });
        const exported = await privacy.requestExport();

        await privacy.runExport(exported.id);

        const archiveKey = store.rows.get(exported.id)?.storageKey;
        const erasure = await privacy.requestErasure();

        // The status moves only after the files are gone, so a failed delete cannot leave an expired export pointing at a live archive.
        await expect(privacy.runErasure(erasure.id)).resolves.toMatchObject({ status: "failed" });
        expect(store.rows.get(exported.id)?.status).toBe("ready");
        expect(archiveKey === undefined ? false : files.files.has(archiveKey)).toBe(true);

        failDelete = false;

        await operator.admin.retry(erasure.id);

        await expect(privacy.runErasure(erasure.id)).resolves.toMatchObject({ status: "completed" });
        expect(store.rows.get(exported.id)?.status).toBe("expired");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });

    it("expires an export that turned ready after the erasure's files step", async () => {
        const store = memoryRequests();
        const { files, privacy } = setup({ data: memoryData({}).port, datasets: [tasks], erasure: NO_GRACE, store });
        const exported = await privacy.requestExport();
        const erasure = await privacy.requestErasure();
        const { listForSubject } = store;
        let lists = 0;

        // The erasure lists the subject's requests in its files step and again when it completes; the export
        // finishes between the two.
        store.listForSubject = async (subjectId) => {
            lists += 1;

            if (lists === 2) {
                await privacy.runExport(exported.id);
            }

            return listForSubject(subjectId);
        };

        await expect(privacy.runErasure(erasure.id)).resolves.toMatchObject({ status: "completed" });
        expect(store.rows.get(exported.id)?.status).toBe("expired");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
    });
});

describe("runErasure", () => {
    it("erases the quiesce dataset before the others", async () => {
        const { calls, port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const { privacy } = setup({ data: port, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await privacy.runErasure(opened.id);

        expect(calls.filter((call) => call.startsWith("erase:"))).toStrictEqual(["erase:scheduler", "erase:tasks"]);
    });

    it("completes when every table reads zero afterwards, with one event per phase", async () => {
        const { port } = memoryData({ goals: 150, jobs: 0, tasks: 40 });
        const { privacy, store } = setup({ data: port, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).resolves.toStrictEqual({ leftover: [], status: "completed" });
        expect(store.events).toStrictEqual(["r1:received", "r1:processing", "r1:completed"]);
    });

    it("refuses an erasure still inside its grace window", async () => {
        const { privacy, store } = setup();
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).rejects.toMatchObject({ code: "UNPROCESSABLE" });
        expect(store.rows.get(opened.id)?.status).toBe("grace");
    });

    it("fails and names the table that still has rows, rather than reporting success", async () => {
        // The verify read reports goals still populated, even though the drain stopped.
        const { port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const stubborn: DataPort = {
            ...port,
            remaining: async () => {
                return { goals: 3, jobs: 0, tasks: 0 };
            },
        };
        const { privacy } = setup({ data: stubborn, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).resolves.toStrictEqual({ leftover: ["goals"], status: "failed" });
    });

    it("fails rather than completing when the verify read leaves out a table of the dataset", async () => {
        const { port } = memoryData({ goals: 0, jobs: 0, tasks: 0 });
        const partial: DataPort = {
            ...port,
            remaining: async () => {
                return { goals: 0 };
            },
        };
        const { privacy, store } = setup({ data: partial, datasets: [tasks, quiesced], erasure: NO_GRACE });
        const opened = await privacy.requestErasure();

        await expect(privacy.runErasure(opened.id)).resolves.toMatchObject({ status: "failed" });
        expect(store.rows.get(opened.id)?.status).toBe("failed");
    });
});

describe("a data port that leaves out a table", () => {
    it("fails the export rather than writing an archive without that table", async () => {
        const { port } = memoryData({});
        const partial: DataPort = {
            ...port,
            collect: async () => {
                return { goals: [] };
            },
        };
        const { files, privacy, store } = setup({ data: partial, datasets: [tasks] });
        const opened = await privacy.requestExport();

        await expect(privacy.runExport(opened.id)).resolves.toMatchObject({ status: "failed" });
        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect([...files.files.keys()].some((key) => key.endsWith("export.zip"))).toBe(false);
    });

    it("names the missing table and its dataset on the failed event", async () => {
        const store = memoryRequests();
        const details: string[] = [];
        const recording = {
            ...store,
            addEvent: async (requestId: string, at: Date, kind: string, detail?: string) => {
                details.push(detail ?? "");
                await store.addEvent(requestId, at, kind, detail);
            },
        };
        const { port } = memoryData({});
        const partial: DataPort = {
            ...port,
            collect: async () => {
                return { goals: [] };
            },
        };
        const { privacy } = setup({ data: partial, datasets: [tasks], store: recording });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        expect(details.join("|")).toContain('table "tasks" of dataset "tasks"');
    });
});

describe("omitted columns", () => {
    it("never writes a column the dataset omits into the archive", async () => {
        const secretDataset = defineDataset("auth", {
            legalBasis: "contract",
            origin: "provided",
            purpose: "Sign-in",
            tables: { session: { omit: ["token"] } },
        });
        const data: DataPort = {
            collect: async () => {
                return { session: [{ id: "s1", token: "live-secret" }] };
            },
            eraseBatch: async () => {
                return { hasMore: false };
            },
            remaining: async () => {
                return { session: 0 };
            },
        };
        const { files, privacy } = setup({ data, datasets: [secretDataset] });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        const archive = unzipSync(files.files.get(exportFileOf(files, opened.id, "export.zip")) as Uint8Array);
        const session = new TextDecoder().decode(archive["data/auth/session.json"]);

        expect(session).not.toContain("live-secret");
        expect(session).toContain("s1");
    });
});

describe("run entries", () => {
    it("refuses an export run on an erasure, and an erasure run on an export, without touching either", async () => {
        expect.assertions(4);

        const { privacy, store } = setup();
        const erasure = await privacy.requestErasure();
        const exported = await privacy.requestExport();

        await expect(codeOf(privacy.runExport(erasure.id))).resolves.toBe("UNPROCESSABLE");
        await expect(codeOf(privacy.runErasure(exported.id))).resolves.toBe("UNPROCESSABLE");
        expect(store.rows.get(erasure.id)?.status).toBe("grace");
        expect(store.rows.get(exported.id)?.status).toBe("received");
    });
});
