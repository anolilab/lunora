import { LunoraError } from "@lunora/errors";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { germany } from "../src/de";
import { definePrivacy } from "../src/define";
import { eu } from "../src/eu";
import { memoryData, memoryFiles, memoryRequests } from "./memory-ports";

const SUBJECT = { sessionAgeMs: 60_000, subjectId: "u1" };

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: { omit: ["activeCycle"] } },
});

const now = new Date("2026-10-11T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_TABLES: Readonly<Record<string, number>> = { goals: 0, tasks: 0 };

const OTHER = { sessionAgeMs: 0, subjectId: "u2" };

/** Build the API as a given subject. Pass a shared store to act on the same requests as another subject. */
const build = (rows: Readonly<Record<string, number>> = EMPTY_TABLES, identity = SUBJECT, store = memoryRequests()) => {
    const files = memoryFiles();
    const data = memoryData(rows);
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
                    return `req-${String(counter)}`;
                },
                now: () => now,
                store,
            };
        },
        presets: [eu(), germany()],
    })(undefined);

    return { data, files, privacy, store };
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

/** Run the erasure workflow to the end, with each step run inline. The grace sleep is skipped for the test. */
const runErasureWorkflow = (
    privacy: {
        workflows: {
            erasureHandler: (context: {
                params: { requestId: string };
                step: { do: <T>(name: string, run: () => Promise<T>) => Promise<T>; sleepUntil: (name: string, when: Date) => Promise<void> };
            }) => Promise<void>;
        };
    },
    requestId: string,
): Promise<void> =>
    privacy.workflows.erasureHandler({
        params: { requestId },
        step: {
            do: async (_name, run) => run(),
            sleepUntil: async () => undefined,
        },
    });

describe("definePrivacy coverage", () => {
    it("reports a table that no dataset and no exclusion covers", () => {
        const { privacy } = build();

        expect(privacy.coverage(["goals", "tasks", "notes"])).toStrictEqual([{ code: "unclassified", table: "notes" }]);
    });

    it("accepts a table excluded with a reason", () => {
        const { privacy } = build();

        expect(privacy.coverage(["goals", "tasks", "featureFlags"], { featureFlags: "Operator configuration; no personal data" })).toStrictEqual([]);
    });
});

describe("definePrivacy export", () => {
    it("opens an export, runs it, and stores the archive and the summary", async () => {
        const { files, privacy } = build();
        const opened = await privacy.requestExport();
        const outcome = await privacy.runExport(opened.id);

        expect(outcome).toMatchObject({ archiveKey: "req-1/export.zip", status: "ready" });
        expect([...files.files.keys()]).toStrictEqual(expect.arrayContaining(["req-1/export.zip", "req-1/summary.pdf"]));
    });

    it("writes a ZIP whose manifest carries the subject key", async () => {
        const { files, privacy } = build();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        const manifest = JSON.parse(new TextDecoder().decode(unzipSync(files.files.get("req-1/export.zip") as Uint8Array)["manifest.json"])) as {
            subjectKey: string;
        };

        expect(manifest.subjectKey).toBe("u1");
    });

    it("refuses to run an export for a request that does not exist", async () => {
        const { privacy } = build();

        await expect(codeOf(privacy.runExport("missing"))).resolves.toBe("NOT_FOUND");
    });
});

describe("definePrivacy erasure", () => {
    it("opens an erasure into the 14-day grace from a fresh sign-in, and lets the subject cancel it", async () => {
        const { privacy } = build();
        const opened = await privacy.requestErasure();

        expect(opened).toMatchObject({ status: "grace" });
        expect(opened.erasureGraceUntil?.getTime()).toBe(now.getTime() + 14 * DAY_MS);
        await expect(privacy.cancelRequest({ requestId: opened.id })).resolves.toMatchObject({ status: "cancelled" });
    });

    it("refuses an erasure from a sign-in older than 24 hours", async () => {
        const { privacy } = build(undefined, { sessionAgeMs: DAY_MS + 1, subjectId: "u1" });

        await expect(codeOf(privacy.requestErasure())).resolves.toBe("PRIVACY_SESSION_NOT_FRESH");
    });

    it("erases the rows and completes once the grace has run", async () => {
        const { data, privacy, store } = build({ goals: 150, tasks: 40 });
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(privacy, opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("completed");
        expect(data.rows).toStrictEqual({ goals: 0, tasks: 0 });
    });

    it("lets a subject extend an export once while the first month runs", async () => {
        const { privacy } = build();
        const opened = await privacy.requestExport();

        await expect(privacy.extendRequest({ reason: "Large request", requestId: opened.id })).resolves.toMatchObject({
            reason: "Large request",
        });
        await expect(codeOf(privacy.extendRequest({ reason: "again", requestId: opened.id }))).resolves.toBe("UNPROCESSABLE");
    });
});

describe("definePrivacy ownership", () => {
    it("refuses to cancel or extend another subject's request, as not found", async () => {
        const { privacy, store } = build();
        const other = build(undefined, OTHER, store).privacy;
        const opened = await privacy.requestErasure();

        await expect(codeOf(other.cancelRequest({ requestId: opened.id }))).resolves.toBe("NOT_FOUND");
        await expect(codeOf(other.extendRequest({ reason: "x", requestId: opened.id }))).resolves.toBe("NOT_FOUND");
    });
});
