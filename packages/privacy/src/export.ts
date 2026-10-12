/**
 * The export's assembly: one part per dataset written to storage as it is collected, then the
 * archive, its manifest and the summary PDF built from the stored parts.
 */
import { encodeWire } from "../../../shared/wire-codec";
import type { ManifestDataset } from "./archive";
import { buildArchive, buildManifest, buildSummaryPdf } from "./archive";
import { articlesFor } from "./articles";
import type { Dataset } from "./dataset";
import { retainedTables } from "./dataset";
import type { PrivacyPorts } from "./ports";
import type { RequestRecord } from "./requests";

const partName = (dataset: Dataset): string => `parts/${dataset.id}.json`;

/** A dataset is restricted (Art. 18) when a retention rule may keep any of its tables after erasure. */
const isRestricted = (dataset: Dataset): boolean => retainedTables(dataset).length > 0;

const retentionText = (dataset: Dataset): string => {
    const names = [...new Set(retainedTables(dataset).map(({ directive }) => directive.rule))];

    return names.length === 0 ? "until erasure" : `kept under ${names.join(", ")}`;
};

/** Rows with the named columns removed, so credential columns never reach the archive. */
const withoutColumns = (
    rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
    omit: ReadonlyArray<string>,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
    if (omit.length === 0) {
        return rows;
    }

    return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !omit.includes(column))));
};

/**
 * Collect one dataset's rows and write them to storage. A retry overwrites the part, so it is idempotent.
 * The rows go through the Lunora wire codec, which plain JSON cannot replace: a `bigint` column would
 * throw and a bytes column would be written as `{}`. The codec writes them as tagged leaves, a bigint
 * as its decimal string and bytes as base64, and the archive keeps that form.
 */
const collectPart = async (ports: PrivacyPorts, dataset: Dataset, request: RequestRecord): Promise<void> => {
    const rows = await ports.data.collect(dataset, request.subjectId);
    // `omit` is applied here, not by the app: a credential column named in the dataset never reaches the archive.
    const tables = Object.fromEntries(dataset.tableNames.map((table) => [table, withoutColumns(rows[table] ?? [], dataset.tables[table]?.omit ?? [])]));

    await ports.files.put(request.id, { data: JSON.stringify(encodeWire({ tables })), name: partName(dataset) });
};

/** Assemble the archive and the summary from the stored parts, then store both. */
const assembleExport = async (ports: PrivacyPorts, datasets: ReadonlyArray<Dataset>, request: RequestRecord, subjectKey: string): Promise<string> => {
    const files: { data: string; path: string }[] = [];
    const manifestDatasets: ManifestDataset[] = [];

    for (const dataset of datasets) {
        // Parts are read in order, so the archive lists datasets in the order they were declared.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
        const text = await ports.files.read(request.id, partName(dataset));

        if (text === undefined) {
            throw new Error(`Export part for "${dataset.id}" is missing; collect it again.`);
        }

        // The part stays in its encoded form: decoding it would bring back the bigint JSON cannot write.
        const { tables } = JSON.parse(text) as { tables: Record<string, unknown[]> };

        for (const table of dataset.tableNames) {
            files.push({ data: JSON.stringify(tables[table] ?? []), path: `data/${dataset.id}/${table}.json` });
        }

        manifestDatasets.push({
            articles: articlesFor(dataset.origin, dataset.legalBasis),
            files: dataset.tableNames.map((table) => `data/${dataset.id}/${table}.json`),
            id: dataset.id,
            legalBasis: dataset.legalBasis,
            origin: dataset.origin,
            purpose: dataset.purpose,
            recipients: dataset.recipients,
            restricted: isRestricted(dataset),
            retention: retentionText(dataset),
        });
    }

    const generatedAt = ports.now();
    const manifest = buildManifest({ datasets: manifestDatasets, generatedAt, subjectKey });
    const zip = buildArchive([...files, { data: JSON.stringify(manifest, undefined, 2), path: "manifest.json" }], generatedAt);
    const pdf = await buildSummaryPdf({
        datasets: manifestDatasets.map((dataset) => {
            return { articles: dataset.articles, id: dataset.id, purpose: dataset.purpose, retention: dataset.retention };
        }),
        generatedAt,
        subjectKey,
        title: "Your data",
    });
    const archiveKey = await ports.files.put(request.id, { data: zip, name: "export.zip" });

    await ports.files.put(request.id, { data: pdf, name: "summary.pdf" });

    return archiveKey;
};

export { assembleExport, collectPart };
