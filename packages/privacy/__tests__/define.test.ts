import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { germany } from "../src/de";
import { eu } from "../src/eu";
import { codeOf, DAY_MS, NOW, setup } from "./harness";

const OTHER = { sessionAgeMs: 0, subjectId: "u2" };

const build = (rows?: Readonly<Record<string, number>>) => setup({ presets: [eu(), germany()], ...(rows === undefined ? {} : { rows }) });

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

        expect(outcome).toMatchObject({ archiveKey: "r1/export.zip", status: "ready" });
        expect([...files.files.keys()]).toStrictEqual(expect.arrayContaining(["r1/export.zip", "r1/summary.pdf"]));
    });

    it("writes a ZIP whose manifest carries the subject key", async () => {
        const { files, privacy } = build();
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);
        const manifest = JSON.parse(new TextDecoder().decode(unzipSync(files.files.get("r1/export.zip") as Uint8Array)["manifest.json"])) as {
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
        expect(opened.erasureGraceUntil?.getTime()).toBe(NOW.getTime() + 14 * DAY_MS);
        await expect(privacy.cancelRequest({ requestId: opened.id })).resolves.toMatchObject({ status: "cancelled" });
    });

    it("refuses an erasure from a sign-in older than 24 hours", async () => {
        const { as } = build();

        await expect(codeOf(as({ sessionAgeMs: DAY_MS + 1, subjectId: "u1" }).requestErasure())).resolves.toBe("PRIVACY_SESSION_NOT_FRESH");
    });

    it("erases the rows and completes once the grace has run", async () => {
        const { privacy, rows, runErasureWorkflow, store } = build({ goals: 150, tasks: 40 });
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("completed");
        expect(rows).toStrictEqual({ goals: 0, tasks: 0 });
    });
});

describe("admin.extend", () => {
    it("lets the operator extend a request once while the first month runs, without a subject identity", async () => {
        const { operator, privacy, store } = build();
        const opened = await privacy.requestExport();

        await expect(operator.admin.extend(opened.id, "Large request")).resolves.toMatchObject({ reason: "Large request" });
        expect(store.rows.get(opened.id)?.extendedDueAt).toBeInstanceOf(Date);
        expect(store.events).toContain(`${opened.id}:extended`);
        await expect(codeOf(operator.admin.extend(opened.id, "again"))).resolves.toBe("UNPROCESSABLE");
    });

    it("offers the subject no way to extend their own deadline", () => {
        const { privacy } = build();

        expect(Object.keys(privacy)).not.toContain("extendRequest");
    });
});

describe("definePrivacy identity", () => {
    it("refuses the subject methods on a call bound without an identity", async () => {
        const { operator, privacy } = build();
        const opened = await privacy.requestExport();

        await expect(codeOf(operator.requestExport())).resolves.toBe("UNAUTHENTICATED");
        await expect(codeOf(operator.myRequests())).resolves.toBe("UNAUTHENTICATED");
        await expect(codeOf(operator.cancelRequest({ requestId: opened.id }))).resolves.toBe("UNAUTHENTICATED");
        await expect(codeOf(operator.downloadUrl({ requestId: opened.id }))).resolves.toBe("UNAUTHENTICATED");
    });

    it("refuses to cancel another subject's request, as not found", async () => {
        const { as, privacy } = build();
        const opened = await privacy.requestErasure();

        await expect(codeOf(as(OTHER).cancelRequest({ requestId: opened.id }))).resolves.toBe("NOT_FOUND");
    });
});
