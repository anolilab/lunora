import { describe, expect, it } from "vitest";

import type { ErasureOptions } from "../src/define";
import type { DataPort } from "../src/ports";
import type { TombstonePort } from "../src/tombstones";
import { codeOf, exportFileOf, memoryData, memoryTombstones, setup } from "./harness";

describe("downloadUrl", () => {
    it("returns a fifteen-minute link to a finished export for its subject", async () => {
        const { files, privacy } = setup();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        await expect(privacy.downloadUrl({ requestId: opened.id })).resolves.toBe(`https://files.test/${exportFileOf(files, opened.id, "export.zip")}?ttl=900`);
    });

    it("answers not found for another subject, so a caller cannot probe ids", async () => {
        const { as, privacy } = setup();
        const other = as({ sessionAgeMs: 0, subjectId: "u2" });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        await expect(codeOf(other.downloadUrl({ requestId: opened.id }))).resolves.toBe("NOT_FOUND");
    });

    it("refuses a download before the export is ready", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport();

        await expect(codeOf(privacy.downloadUrl({ requestId: opened.id }))).resolves.toBe("UNPROCESSABLE");
    });

    it("refuses a download after the seven-day window", async () => {
        const { advance, privacy } = setup();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        advance(8);

        await expect(codeOf(privacy.downloadUrl({ requestId: opened.id }))).resolves.toBe("UNPROCESSABLE");
    });
});

describe("admin", () => {
    it("lists the requests that are still open", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport();

        const open = await privacy.admin.open();

        expect(open.map((record) => record.id)).toStrictEqual([opened.id]);
    });

    it("re-runs a failed export, and the export then becomes ready", async () => {
        let failing = true;
        const healthy = memoryData();
        const flaky: DataPort = {
            ...healthy,
            collect: async (dataset) => {
                if (failing) {
                    throw new Error("disk full");
                }

                return healthy.collect(dataset, "u1");
            },
        };
        const { operator, privacy, runExportWorkflow, store } = setup({ data: flaky });
        const opened = await privacy.requestExport();

        const first = await privacy.runExport(opened.id);

        expect(first.status).toBe("failed");

        failing = false;

        await expect(operator.admin.retry(opened.id)).resolves.toStrictEqual({ requestId: opened.id, type: "export" });

        await runExportWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });

    it("hands a failed export back to its workflow, which alone reads the tombstone store", async () => {
        let failing = true;
        let reachable = true;
        const healthy = memoryData();
        const flaky: DataPort = {
            ...healthy,
            collect: async (dataset) => {
                if (failing) {
                    throw new Error("disk full");
                }

                return healthy.collect(dataset, "u1");
            },
        };
        const tombstones = memoryTombstones();
        // The operator's mutation cannot reach the store, as in the example app; the workflow can.
        const mutationBound: TombstonePort = {
            add: tombstones.add,
            has: async (key) => {
                if (!reachable) {
                    throw new Error("tombstone store unreachable");
                }

                return tombstones.has(key);
            },
            keys: tombstones.keys,
        };
        const { operator, privacy, runExportWorkflow, store } = setup({ data: flaky, tombstones: mutationBound });
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        failing = false;
        reachable = false;

        await expect(operator.admin.retry(opened.id)).resolves.toStrictEqual({ requestId: opened.id, type: "export" });
        expect(store.rows.get(opened.id)?.status).toBe("processing");
        await expect(codeOf(operator.admin.retry(opened.id))).resolves.toBe("UNPROCESSABLE");

        reachable = true;
        await runExportWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });

    it("hands a failed erasure back for its workflow to restart, once, and the workflow finishes it", async () => {
        const healthy = memoryData({ goals: 0, tasks: 0 });
        let failing = true;
        const flaky: DataPort = {
            ...healthy,
            eraseBatch: async (...args) => {
                if (failing) {
                    throw new Error("shard unavailable");
                }

                return healthy.eraseBatch(...args);
            },
        };
        const { operator, privacy, runErasureWorkflow, store } = setup({ data: flaky, erasure: { graceDays: 0 } });
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("failed");

        failing = false;

        // Each retry is its own mutation, so the second one reads the status the first one wrote.
        await expect(operator.admin.retry(opened.id)).resolves.toStrictEqual({ requestId: opened.id, type: "erasure" });
        await expect(codeOf(operator.admin.retry(opened.id))).resolves.toBe("UNPROCESSABLE");
        expect(store.rows.get(opened.id)?.status).toBe("processing");

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("completed");
    });

    it("lets exactly one of two concurrent retries restart a failed erasure", async () => {
        expect.assertions(2);

        let failing = true;
        const healthy = memoryData();
        const flaky: DataPort = {
            ...healthy,
            eraseBatch: async (...args) => {
                if (failing) {
                    throw new Error("shard unavailable");
                }

                return healthy.eraseBatch(...args);
            },
        };
        const { operator, privacy, runErasureWorkflow, store } = setup({ data: flaky, erasure: { graceDays: 0 } });
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);
        failing = false;

        const results = await Promise.allSettled([operator.admin.retry(opened.id), operator.admin.retry(opened.id)]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(store.rows.get(opened.id)?.status).toBe("processing");
    });

    it("refuses to retry a request that has not failed", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport();

        await expect(codeOf(privacy.admin.retry(opened.id))).resolves.toBe("UNPROCESSABLE");
    });

    it("expires a ready export past its window and deletes every file it wrote", async () => {
        const { advance, files, privacy, store } = setup();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        expect([...files.files.keys()].some((key) => key.startsWith(`${opened.id}/`))).toBe(true);

        advance(8);
        const { expired } = await privacy.admin.sweep();

        expect(expired.map((record) => record.id)).toStrictEqual([opened.id]);
        expect(store.rows.get(opened.id)?.status).toBe("expired");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${opened.id}/`))).toStrictEqual([]);
        await expect(privacy.admin.open()).resolves.toStrictEqual([]);
        await expect(privacy.tick()).resolves.toStrictEqual({ approaching: [], overdue: [] });
    });

    it("leaves a ready export inside its window alone", async () => {
        const { advance, files, privacy, store } = setup();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        advance(6);

        await expect(privacy.admin.sweep()).resolves.toStrictEqual({ expired: [], purged: 0 });
        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(files.files.has(exportFileOf(files, opened.id, "export.zip"))).toBe(true);
    });

    it("lets the subject open a new export once the old one expired", async () => {
        const { advance, privacy } = setup();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        advance(8);
        await privacy.admin.sweep();

        await expect(privacy.requestExport()).resolves.toMatchObject({ status: "received" });
    });
});

describe("erasing a subject with a ready export", () => {
    const NO_GRACE: ErasureOptions = { graceDays: 0 };

    it("expires the export and deletes its files when the erasure runs", async () => {
        const { files, privacy, store } = setup({ erasure: NO_GRACE });
        const exported = await privacy.requestExport();

        await privacy.runExport(exported.id);

        const erasure = await privacy.requestErasure();

        await privacy.runErasure(erasure.id);

        expect(store.rows.get(exported.id)?.status).toBe("expired");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
        // The erasure rewrote the subject id on the export, so the erased subject no longer finds it at all.
        await expect(codeOf(privacy.downloadUrl({ requestId: exported.id }))).resolves.toBe("NOT_FOUND");
    });

    it("does the same when the erasure workflow runs", async () => {
        const { files, privacy, runErasureWorkflow, store } = setup({ erasure: NO_GRACE });
        const exported = await privacy.requestExport();

        await privacy.runExport(exported.id);

        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(store.rows.get(exported.id)?.status).toBe("expired");
        expect([...files.files.keys()].filter((key) => key.startsWith(`${exported.id}/`))).toStrictEqual([]);
        // The erasure rewrote the subject id on the export, so the erased subject no longer finds it at all.
        await expect(codeOf(privacy.downloadUrl({ requestId: exported.id }))).resolves.toBe("NOT_FOUND");
    });
});
