import { describe, expect, it } from "vitest";

import { storageObjectsDataset } from "../src/builtins";
import type { MemoryFiles } from "./harness";
import { exportFileOf, memoryFiles, setup, tasksDataset } from "./harness";

const uploads = storageObjectsDataset((subjectId) => `uploads/${subjectId}/`);

const build = (files: MemoryFiles = memoryFiles(), datasets = [tasksDataset, uploads]) => setup({ datasets, files });

const keys = (files: Map<string, unknown>): ReadonlyArray<string> => [...files.keys()].toSorted((a, b) => a.localeCompare(b));

describe("erasure of stored files", () => {
    it("deletes the subject's export files and uploads, and leaves another subject's alone", async () => {
        const { as, files, privacy, runErasureWorkflow, store } = build();
        const other = as({ sessionAgeMs: 0, subjectId: "u2" });
        const otherExport = await other.requestExport();

        await other.runExport(otherExport.id);
        files.files.set("uploads/u2/avatar.png", "u2");

        const oldExport = await privacy.requestExport();

        await privacy.runExport(oldExport.id);
        files.files.set("uploads/u1/avatar.png", "u1");
        files.files.set("uploads/u1/docs/cv.pdf", "u1");

        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(keys(files.files).filter((key) => key.startsWith(`${oldExport.id}/`) || key.startsWith("uploads/u1/"))).toStrictEqual([]);
        expect(keys(files.files)).toStrictEqual(
            expect.arrayContaining([
                exportFileOf(files, otherExport.id, "export.zip"),
                exportFileOf(files, otherExport.id, "tasks.json"),
                "uploads/u2/avatar.png",
            ]),
        );
    });

    it("deletes the files through the direct erasure entry too", async () => {
        const { files, privacy, store } = build();
        const oldExport = await privacy.requestExport();

        await privacy.runExport(oldExport.id);
        files.files.set("uploads/u1/avatar.png", "u1");

        const erasure = await privacy.requestErasure();

        // The direct entry refuses an erasure inside its grace, so the test moves it past the grace.
        store.rows.set(erasure.id, { ...store.rows.get(erasure.id)!, status: "received" });

        await expect(privacy.runErasure(erasure.id)).resolves.toStrictEqual({ leftover: [], status: "completed" });
        expect(keys(files.files)).toStrictEqual([]);
    });

    it("fails the erasure when an upload is still listed afterwards", async () => {
        const base = memoryFiles();
        // A store whose deletes silently do nothing, so the listing still shows the file.
        const stubborn = { ...base, delete: async () => undefined };
        const { privacy, runErasureWorkflow, store } = build(stubborn);

        base.files.set("uploads/u1/avatar.png", "u1");

        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("failed");
        expect(store.events).toContain(`${erasure.id}:failed`);
    });

    it("refuses an empty files prefix rather than deleting every subject's files", async () => {
        const everyone = storageObjectsDataset(() => "");
        const { files, privacy, runErasureWorkflow, store } = build(memoryFiles(), [tasksDataset, everyone]);

        files.files.set("uploads/u2/avatar.png", "u2");

        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("failed");
        expect(files.files.has("uploads/u2/avatar.png")).toBe(true);
    });
});
