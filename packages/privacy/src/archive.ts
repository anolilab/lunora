/**
 * The export archive: a manifest that says what each dataset is and why it is
 * held, a compressed ZIP of the JSON data, and a readable PDF copy. Every clock
 * value comes from the caller, so the same inputs give the same bytes.
 */
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { zipSync } from "fflate";

import type { DataOrigin, ExportArticle, LegalBasis } from "./articles";

/** The manifest format. Bumped when a consumer would have to change how it reads the archive. */
const MANIFEST_FORMAT_VERSION = 1;

/** One dataset's entry in the manifest. */
interface ManifestDataset {
    readonly articles: ReadonlyArray<ExportArticle>;
    readonly files: ReadonlyArray<string>;
    readonly id: string;
    readonly legalBasis: LegalBasis;
    readonly origin: DataOrigin;
    readonly purpose: string;
    readonly recipients: ReadonlyArray<string>;
    readonly restricted: boolean;
    readonly retention: string;
}

/** The manifest at the root of the archive. */
interface Manifest {
    readonly datasets: ReadonlyArray<ManifestDataset>;
    readonly formatVersion: typeof MANIFEST_FORMAT_VERSION;
    readonly generatedAt: string;
    readonly subjectKey: string;
}

/** Build the manifest. The generation time is the caller's clock. */
const buildManifest = (input: { datasets: ReadonlyArray<ManifestDataset>; generatedAt: Date; subjectKey: string }): Manifest => {
    return {
        datasets: input.datasets,
        formatVersion: MANIFEST_FORMAT_VERSION,
        generatedAt: input.generatedAt.toISOString(),
        subjectKey: input.subjectKey,
    };
};

/** A file to put in the archive. */
interface ArchiveFile {
    readonly data: Uint8Array | string;
    readonly path: string;
}

/**
 * Compress the files into one ZIP with DEFLATE. The entry times are the caller's
 * clock, so two runs over the same data give the same bytes.
 */
const buildArchive = (files: ReadonlyArray<ArchiveFile>, generatedAt: Date, level: 0 | 1 | 6 | 9 = 6): Uint8Array => {
    const encoder = new TextEncoder();
    const entries: Record<string, [Uint8Array, { level: 0 | 1 | 6 | 9; mtime: Date }]> = {};

    for (const file of files) {
        const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;

        entries[file.path] = [data, { level, mtime: generatedAt }];
    }

    return zipSync(entries);
};

/** A dataset's readable summary, for the PDF cover copy. */
interface SummaryDataset {
    readonly articles: ReadonlyArray<ExportArticle>;
    readonly id: string;
    readonly purpose: string;
    readonly retention: string;
}

/**
 * The standard PDF fonts cover WinAnsi only; drawing any other character throws, which would fail every
 * retry of the export. Characters outside WinAnsi are replaced by "?", so the summary always renders.
 */
const WIN_ANSI_EXCLUDED =
    /[^\u0020-\u007E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/gu;

const toWinAnsi = (text: string): string => text.replaceAll(WIN_ANSI_EXCLUDED, "?");

const LINE_HEIGHT = 14;
const TOP = 780;
const LEFT = 40;
const MAX_LINES_PER_PAGE = 50;

/**
 * A readable copy of the export: what was held, under which article, and for how
 * long. The creation and modification dates are fixed to `generatedAt`, so the
 * bytes do not depend on when the PDF was rendered.
 */
const buildSummaryPdf = async (input: {
    datasets: ReadonlyArray<SummaryDataset>;
    generatedAt: Date;
    subjectKey: string;
    title: string;
}): Promise<Uint8Array> => {
    const pdf = await PDFDocument.create();

    pdf.setCreationDate(input.generatedAt);
    pdf.setModificationDate(input.generatedAt);
    pdf.setProducer("@lunora/privacy");
    pdf.setCreator("@lunora/privacy");
    pdf.setTitle(input.title);

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines: string[] = [
        input.title,
        `Generated: ${input.generatedAt.toISOString()}`,
        `Subject: ${input.subjectKey}`,
        "",
        ...input.datasets.flatMap((dataset) => [
            `${dataset.id}: ${dataset.purpose}`,
            `  Articles: ${dataset.articles.map((article) => `Art. ${article}`).join(", ")}`,
            `  Retention: ${dataset.retention}`,
        ]),
    ];

    for (let start = 0; start < lines.length; start += MAX_LINES_PER_PAGE) {
        const page = pdf.addPage();

        lines.slice(start, start + MAX_LINES_PER_PAGE).forEach((text, index) => {
            page.drawText(toWinAnsi(text), { font, size: 10, x: LEFT, y: TOP - index * LINE_HEIGHT });
        });
    }

    return pdf.save();
};

export { type ArchiveFile, buildArchive, buildManifest, buildSummaryPdf, type Manifest, MANIFEST_FORMAT_VERSION, type ManifestDataset, type SummaryDataset };
