import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { definePrivacy } from "../src/define";
import type { DataPort } from "../src/run";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { tasks: {} },
});

const DAY_MS = 24 * 60 * 60 * 1000;

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

const setup = (data: DataPort = memoryData({ tasks: 0 })) => {
    const store = memoryRequests();
    const files = memoryFiles();
    let clock = new Date("2026-10-11T10:00:00.000Z");
    let counter = 0;
    const privacy = definePrivacy({
        datasets: [tasks],
        ports: () => {
            return {
                data,
                files,
                newId: () => {
                    counter += 1;
                    return `r${String(counter)}`;
                },
                now: () => clock,
                store,
            };
        },
    })(undefined);

    return {
        advance: (days: number) => {
            clock = new Date(clock.getTime() + days * DAY_MS);
        },
        files,
        privacy,
        store,
    };
};

describe("downloadUrl", () => {
    it("returns a fifteen-minute link to a finished export for its subject", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        await privacy.runExport(opened.id);

        await expect(privacy.downloadUrl({ requestId: opened.id, subjectId: "u1" })).resolves.toBe(`https://files.test/${opened.id}/export.zip?ttl=900`);
    });

    it("answers not found for another subject, so a caller cannot probe ids", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        await privacy.runExport(opened.id);

        await expect(codeOf(privacy.downloadUrl({ requestId: opened.id, subjectId: "u2" }))).resolves.toBe("NOT_FOUND");
    });

    it("refuses a download before the export is ready", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        await expect(codeOf(privacy.downloadUrl({ requestId: opened.id, subjectId: "u1" }))).resolves.toBe("UNPROCESSABLE");
    });

    it("refuses a download after the seven-day window", async () => {
        const { advance, privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        await privacy.runExport(opened.id);
        advance(8);

        await expect(codeOf(privacy.downloadUrl({ requestId: opened.id, subjectId: "u1" }))).resolves.toBe("UNPROCESSABLE");
    });
});

describe("admin", () => {
    it("lists the requests that are still open", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        const open = await privacy.admin.open();

        expect(open.map((record) => record.id)).toStrictEqual([opened.id]);
    });

    it("re-runs a failed export, and the export then becomes ready", async () => {
        let failing = true;
        const healthy = memoryData({ tasks: 0 });
        const flaky: DataPort = {
            ...healthy,
            collect: async (dataset) => {
                if (failing) {
                    throw new Error("disk full");
                }

                return healthy.collect(dataset, "u1");
            },
        };
        const { privacy, store } = setup(flaky);
        const opened = await privacy.requestExport({ subjectId: "u1" });

        const first = await privacy.runExport(opened.id);

        expect(first.status).toBe("failed");

        failing = false;

        await expect(privacy.admin.retry(opened.id)).resolves.toMatchObject({ status: "ready" });
        expect(store.rows.get(opened.id)?.status).toBe("ready");
    });

    it("refuses to retry a request that has not failed", async () => {
        const { privacy } = setup();
        const opened = await privacy.requestExport({ subjectId: "u1" });

        await expect(codeOf(privacy.admin.retry(opened.id))).resolves.toBe("UNPROCESSABLE");
    });
});
