/**
 * The export and erasure runs, as host-free steps. A host (the Workflow binding on
 * Cloudflare, or a test double) calls these; they call the data, store and request
 * ports, so the order and the outcome are tested without a runtime.
 *
 * The export is written as one part per dataset. Each part goes to storage as it is
 * collected, so a step's result is a receipt, not the rows: a heavy subject's data
 * never has to fit in a single step result.
 */
import type { ManifestDataset } from "./archive";
import { buildArchive, buildManifest, buildSummaryPdf } from "./archive";
import { articlesFor } from "./articles";
import type { Dataset } from "./dataset";
import { erasureOrder } from "./dataset";
import { drainUntilEmpty, verifyErasure } from "./erasure";
import type { RequestStatus } from "./lifecycle";
import { transition } from "./lifecycle";
import type { RequestRecord, RequestStore } from "./requests";
import type { RetentionRule } from "./rules";

/** The app's data, one dataset at a time. The app implements it over its tables. */
interface DataPort {
    /** The subject's rows for each table of the dataset, keyed by table name. */
    readonly collect: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>>;
    /** Erase one batch of the dataset's rows for the subject. */
    readonly eraseBatch: (dataset: Dataset, subjectId: string, now: Date) => Promise<{ readonly hasMore: boolean }>;
    /** Rows still present per table after erasure, for the verify step. */
    readonly remaining: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, number>>>;
}

/** Where a request's files are kept between steps and in the end. */
interface StorePort {
    readonly put: (requestId: string, file: { readonly data: Uint8Array | string; readonly name: string }) => Promise<string>;
    /** The text of a file written earlier in the same request, or `undefined` if it is not there. */
    readonly read: (requestId: string, name: string) => Promise<string | undefined>;
}

/** The run's shared inputs. */
interface RunContext {
    readonly data: DataPort;
    readonly files: StorePort;
    readonly now: () => Date;
    readonly rules: ReadonlyMap<string, RetentionRule>;
    readonly store: RequestStore;
    readonly subjectKey: string;
}

/** The outcome of an export run. */
interface ExportOutcome {
    readonly archiveKey?: string;
    readonly status: RequestStatus;
}

/** The outcome of an erasure run. */
interface ErasureOutcome {
    readonly leftover: ReadonlyArray<string>;
    readonly status: RequestStatus;
}

const partName = (dataset: Dataset): string => `parts/${dataset.id}.json`;

const retentionText = (dataset: Dataset): string => {
    const names = [
        ...new Set(
            dataset.tableNames
                .map((table) => dataset.tables[table]?.erase)
                .filter((erase): erase is { kind: "retain"; rule: string } => typeof erase === "object")
                .map((erase) => erase.rule),
        ),
    ];

    return names.length === 0 ? "until erasure" : `kept under ${names.join(", ")}`;
};

/** Collect one dataset's rows and write them to storage. A retry overwrites the part, so it is idempotent. */
const collectPart = async (context: RunContext, dataset: Dataset, request: RequestRecord): Promise<void> => {
    const rows = await context.data.collect(dataset, request.subjectId);
    const tables = Object.fromEntries(dataset.tableNames.map((table) => [table, rows[table] ?? []]));

    await context.files.put(request.id, { data: JSON.stringify({ tables }), name: partName(dataset) });
};

/** Assemble the archive and the summary from the stored parts, then store both. */
const assembleExport = async (context: RunContext, datasets: ReadonlyArray<Dataset>, request: RequestRecord): Promise<string> => {
    const files: { data: string; path: string }[] = [];
    const manifestDatasets: ManifestDataset[] = [];

    for (const dataset of datasets) {
        // Parts are read in order, so the archive lists datasets in the order they were declared.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
        const text = await context.files.read(request.id, partName(dataset));

        if (text === undefined) {
            throw new Error(`Export part for "${dataset.id}" is missing; collect it again.`);
        }

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
            restricted: false,
            retention: retentionText(dataset),
        });
    }

    const generatedAt = context.now();
    const manifest = buildManifest({ datasets: manifestDatasets, generatedAt, subjectKey: context.subjectKey });
    const zip = buildArchive([...files, { data: JSON.stringify(manifest, undefined, 2), path: "manifest.json" }], generatedAt);
    const pdf = await buildSummaryPdf({
        datasets: manifestDatasets.map((dataset) => {
            return { articles: dataset.articles, id: dataset.id, purpose: dataset.purpose, retention: dataset.retention };
        }),
        generatedAt,
        subjectKey: context.subjectKey,
        title: "Your data",
    });
    const archiveKey = await context.files.put(request.id, { data: zip, name: "export.zip" });

    await context.files.put(request.id, { data: pdf, name: "summary.pdf" });

    return archiveKey;
};

/**
 * Export the subject's data in one call: collect each dataset, assemble, and mark
 * the request ready. A failure marks it `failed` for an operator to retry; the
 * Art. 12(3) clock keeps running.
 */
const runExport = async (context: RunContext, datasets: ReadonlyArray<Dataset>, request: RequestRecord): Promise<ExportOutcome> => {
    let status: RequestStatus = transition(request.status, "processing");

    await context.store.update(request.id, { status });
    await context.store.addEvent(request.id, context.now(), "processing");

    try {
        for (const dataset of datasets) {
            // Datasets are collected one at a time so a failure names the dataset that broke.
            // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
            await collectPart(context, dataset, request);
        }

        const archiveKey = await assembleExport(context, datasets, request);

        status = transition(status, "ready");
        await context.store.update(request.id, { status });
        await context.store.addEvent(request.id, context.now(), "ready");

        return { archiveKey, status };
    } catch (error) {
        status = transition(status, "failed");
        await context.store.update(request.id, { status });
        await context.store.addEvent(request.id, context.now(), "failed", error instanceof Error ? error.message : String(error));

        return { status };
    }
};

/**
 * Erase the subject's data in dataset order, then verify. The request completes
 * only when every table reads zero afterwards; otherwise it is `failed` and names
 * the leftover tables.
 */
const runErasure = async (context: RunContext, datasets: ReadonlyArray<Dataset>, request: RequestRecord): Promise<ErasureOutcome> => {
    let status: RequestStatus = transition(request.status, "processing");

    await context.store.update(request.id, { status });
    await context.store.addEvent(request.id, context.now(), "erasing");

    try {
        for (const dataset of erasureOrder(datasets)) {
            // Datasets erase in order, and each drain finishes before the next starts.
            // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
            await drainUntilEmpty(() => context.data.eraseBatch(dataset, request.subjectId, context.now()));
        }

        const remaining: Record<string, number> = {};

        for (const dataset of datasets) {
            // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
            Object.assign(remaining, await context.data.remaining(dataset, request.subjectId));
        }

        const verdict = verifyErasure(remaining);

        status = transition(status, verdict.complete ? "completed" : "failed");
        await context.store.update(request.id, { status });
        await context.store.addEvent(request.id, context.now(), verdict.complete ? "completed" : "failed", verdict.leftover.join(","));

        return { leftover: verdict.leftover, status };
    } catch (error) {
        status = transition(status, "failed");
        await context.store.update(request.id, { status });
        await context.store.addEvent(request.id, context.now(), "failed", error instanceof Error ? error.message : String(error));

        return { leftover: [], status };
    }
};

export { assembleExport, collectPart, type DataPort, type ErasureOutcome, type ExportOutcome, type RunContext, runErasure, runExport, type StorePort };
