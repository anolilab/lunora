import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { definePrivacy } from "../src/define";
import type { DataPort } from "../src/run";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const SUBJECT = { sessionAgeMs: 60_000, subjectId: "u1" };

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

const setup = (data: DataPort = memoryData({ tasks: 0 }), identity = SUBJECT, store = memoryRequests()) => {
    const files = memoryFiles();
    let clock = new Date("2026-10-11T10:00:00.000Z");
    let counter = 0;
    const privacy = definePrivacy({
        datasets: [tasks],
        ports: () => {
            return {
                identity: () => identity,
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
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        await expect(privacy.downloadUrl({ requestId: opened.id })).resolves.toBe(`https://files.test/${opened.id}/export.zip?ttl=900`);
    });

    it("answers not found for another subject, so a caller cannot probe ids", async () => {
        const { privacy, store } = setup();
        const other = setup(undefined, { sessionAgeMs: 0, subjectId: "u2" }, store).privacy;
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
        const opened = await privacy.requestExport();

        const first = await privacy.runExport(opened.id);

        expect(first.status).toBe("failed");

        failing = false;

        await expect(privacy.admin.retry(opened.id)).resolves.toMatchObject({ status: "ready" });
        expect(store.rows.get(opened.id)?.status).toBe("ready");
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
        const expired = await privacy.admin.sweep();

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

        await expect(privacy.admin.sweep()).resolves.toStrictEqual([]);
        expect(store.rows.get(opened.id)?.status).toBe("ready");
        expect(files.files.has(`${opened.id}/export.zip`)).toBe(true);
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
