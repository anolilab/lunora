import { describe, expect, it } from "vitest";

import { storageObjectsDataset } from "../src/builtins";
import { defineDataset } from "../src/dataset";
import type { PrivacyWorkflowContext } from "../src/define";
import { definePrivacy } from "../src/define";
import type { StorePort } from "../src/run";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { tasks: {} },
});

const uploads = storageObjectsDataset((subjectId) => `uploads/${subjectId}/`);

const inline: PrivacyWorkflowContext["step"] = {
    do: async (_name, run) => run(),
    sleepUntil: async () => undefined,
};

const build = (files: StorePort & { files: Map<string, Uint8Array | string> } = memoryFiles(), datasets = [tasks, uploads]) => {
    const store = memoryRequests();
    let counter = 0;
    let subjectId = "u1";
    const privacy = definePrivacy({
        datasets,
        ports: () => {
            return {
                data: memoryData({ tasks: 0 }),
                files,
                identity: () => {
                    return { sessionAgeMs: 0, subjectId };
                },
                newId: () => {
                    counter += 1;

                    return `r${String(counter)}`;
                },
                now: () => new Date("2026-10-11T10:00:00.000Z"),
                store,
            };
        },
    })(undefined);

    return {
        as: (id: string) => {
            subjectId = id;
        },
        files,
        privacy,
        store,
    };
};

const keys = (files: Map<string, unknown>): ReadonlyArray<string> => [...files.keys()].toSorted((a, b) => a.localeCompare(b));

describe("erasure of stored files", () => {
    it("deletes the subject's export files and uploads, and leaves another subject's alone", async () => {
        const { as, files, privacy, store } = build();

        as("u2");
        const otherExport = await privacy.requestExport();

        await privacy.runExport(otherExport.id);
        files.files.set("uploads/u2/avatar.png", "u2");

        as("u1");
        const oldExport = await privacy.requestExport();

        await privacy.runExport(oldExport.id);
        files.files.set("uploads/u1/avatar.png", "u1");
        files.files.set("uploads/u1/docs/cv.pdf", "u1");

        const erasure = await privacy.requestErasure();

        await privacy.workflows.erasureHandler({ params: { requestId: erasure.id }, step: inline });

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(keys(files.files).filter((key) => key.startsWith(`${oldExport.id}/`) || key.startsWith("uploads/u1/"))).toStrictEqual([]);
        expect(keys(files.files)).toStrictEqual(
            expect.arrayContaining([`${otherExport.id}/export.zip`, `${otherExport.id}/parts/tasks.json`, "uploads/u2/avatar.png"]),
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
        const { privacy, store } = build(stubborn);

        base.files.set("uploads/u1/avatar.png", "u1");

        const erasure = await privacy.requestErasure();

        await privacy.workflows.erasureHandler({ params: { requestId: erasure.id }, step: inline });

        expect(store.rows.get(erasure.id)?.status).toBe("failed");
        expect(store.events).toContain(`${erasure.id}:failed`);
    });

    it("refuses an empty files prefix rather than deleting every subject's files", async () => {
        const everyone = storageObjectsDataset(() => "");
        const { files, privacy, store } = build(memoryFiles(), [tasks, everyone]);

        files.files.set("uploads/u2/avatar.png", "u2");

        const erasure = await privacy.requestErasure();

        await privacy.workflows.erasureHandler({ params: { requestId: erasure.id }, step: inline });

        expect(store.rows.get(erasure.id)?.status).toBe("failed");
        expect(files.files.has("uploads/u2/avatar.png")).toBe(true);
    });
});
