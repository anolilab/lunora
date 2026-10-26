/**
 * The package's own code on workerd: the export archive (the ZIP and the summary PDF) and the request
 * lifecycle over the in-memory ports. The node suite runs the same functions, so a difference between the
 * two runtimes shows here as a failure in this file.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { buildArchive, buildSummaryPdf } from "../../src/archive";
import { setup } from "../harness";

const SUMMARY = {
    datasets: [{ articles: ["15", "20"] as const, id: "tasks", purpose: "Tasks the user keeps", retention: "Until erasure" }],
    generatedAt: new Date("2026-10-26T00:00:00.000Z"),
    subjectKey: "subject",
    title: "Your data",
};

describe("the export archive on workerd", () => {
    it("writes a ZIP that unzips to the files it was given", () => {
        expect.assertions(1);

        const archive = buildArchive(
            [
                { data: '{"rows":[1,2]}', path: "data/tasks/tasks.json" },
                { data: "manifest", path: "manifest.json" },
            ],
            new Date("2026-10-26T00:00:00.000Z"),
        );

        expect(Object.keys(unzipSync(archive)).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["data/tasks/tasks.json", "manifest.json"]);
    });

    it("renders a summary PDF that a PDF parser reads back with its pages", async () => {
        expect.assertions(1);

        const bytes = await buildSummaryPdf(SUMMARY);

        await expect(PDFDocument.load(bytes).then((document) => document.getPageCount())).resolves.toBeGreaterThan(0);
    });

    it("writes the same bytes for the same inputs", async () => {
        expect.assertions(1);

        const first = await buildSummaryPdf(SUMMARY);
        const second = await buildSummaryPdf(SUMMARY);

        expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    });
});

describe("the request lifecycle on workerd", () => {
    it("exports the subject's rows into an archive that lists every dataset", async () => {
        expect.assertions(2);

        const harness = setup({ rows: { goals: 0, tasks: 2 } });
        const opened = await harness.privacy.requestExport();

        await expect(harness.privacy.runExport(opened.id)).resolves.toMatchObject({ status: "ready" });

        const extracted = unzipSync(harness.files.files.get("r1/export.zip") as Uint8Array);

        expect(Object.keys(extracted)).toStrictEqual(expect.arrayContaining(["manifest.json", "data/tasks/tasks.json"]));
    });

    it("erases the subject's rows, and the request ends completed", async () => {
        expect.assertions(2);

        const harness = setup({ rows: { goals: 3, tasks: 2 } });
        const opened = await harness.privacy.requestErasure();

        await harness.runErasureWorkflow(opened.id);

        expect(harness.rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(harness.store.rows.get(opened.id)?.status).toBe("completed");
    });
});
