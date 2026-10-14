import { PDFDocument } from "@cantoo/pdf-lib";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { buildArchive, buildManifest, buildSummaryPdf, MANIFEST_FORMAT_VERSION } from "../src/archive";

const generatedAt = new Date("2026-10-11T10:00:00.000Z");

describe(buildManifest, () => {
    it("records the format version, the generation time and each dataset's basis", () => {
        const manifest = buildManifest({
            datasets: [
                {
                    articles: ["15", "20"],
                    files: ["data/tasks.json"],
                    id: "tasks",
                    legalBasis: "contract",
                    origin: "provided",
                    purpose: "Tasks the user schedules",
                    recipients: [],
                    restricted: false,
                    retention: "until erasure",
                },
            ],
            generatedAt,
            subjectKey: "subject-1",
        });

        expect(manifest).toMatchObject({ formatVersion: MANIFEST_FORMAT_VERSION, generatedAt: "2026-10-11T10:00:00.000Z", subjectKey: "subject-1" });
        expect(manifest.datasets[0]).toMatchObject({ articles: ["15", "20"], legalBasis: "contract" });
    });
});

describe(buildArchive, () => {
    it("round-trips every file through a valid ZIP", () => {
        const archive = buildArchive(
            [
                { data: JSON.stringify({ rows: [1, 2, 3] }), path: "data/tasks.json" },
                { data: new TextEncoder().encode("manifest"), path: "manifest.json" },
            ],
            generatedAt,
        );

        const extracted = unzipSync(archive);

        expect(new TextDecoder().decode(extracted["data/tasks.json"])).toBe('{"rows":[1,2,3]}');
        expect(new TextDecoder().decode(extracted["manifest.json"])).toBe("manifest");
    });

    it("compresses repetitive JSON well below its raw size", () => {
        const raw = JSON.stringify({
            rows: Array.from({ length: 5000 }, (_, id) => {
                return { id, text: "x".repeat(40) };
            }),
        });
        const archive = buildArchive([{ data: raw, path: "data/big.json" }], generatedAt);

        expect(archive.length).toBeLessThan(raw.length / 10);
    });

    it("gives identical bytes for identical input and clock", () => {
        const files = [{ data: '{"a":1}', path: "data/a.json" }];

        expect(buildArchive(files, generatedAt)).toStrictEqual(buildArchive(files, generatedAt));
    });
});

describe(buildSummaryPdf, () => {
    const input = {
        datasets: [{ articles: ["15", "20"] as const, id: "tasks", purpose: "Tasks the user schedules", retention: "until erasure" }],
        generatedAt,
        subjectKey: "subject-1",
        title: "Your data",
    };

    it("starts with the PDF header", async () => {
        const bytes = await buildSummaryPdf({ ...input, datasets: [...input.datasets] });

        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    });

    it("gives identical bytes for two renders with the same clock", async () => {
        const first = await buildSummaryPdf({ ...input, datasets: [...input.datasets] });
        const second = await buildSummaryPdf({ ...input, datasets: [...input.datasets] });

        expect(first).toStrictEqual(second);
    });

    it("paginates a long dataset list", async () => {
        const many = Array.from({ length: 120 }, (_, index) => {
            return { articles: ["15"] as const, id: `d${String(index)}`, purpose: "p", retention: "r" };
        });
        const bytes = await buildSummaryPdf({ ...input, datasets: many });
        const document = await PDFDocument.load(bytes);

        // Four header lines, then three lines per dataset, at 50 lines a page: ceil(364 / 50).
        expect(document.getPageCount()).toBe(8);
    });
});

describe("buildSummaryPdf with characters outside the standard font", () => {
    it("renders a subject's CJK and emoji text instead of throwing", async () => {
        const bytes = await buildSummaryPdf({
            datasets: [{ articles: ["15"] as const, id: "notes", purpose: "笔记 📝 Notizen", retention: "until erasure" }],
            generatedAt: new Date("2026-10-11T10:00:00.000Z"),
            subjectKey: "用户-1",
            title: "Your data",
        });

        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    });
});
