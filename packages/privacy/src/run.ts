/**
 * The export and erasure runs, as host-free steps. A host (the Workflow binding on
 * Cloudflare, or a test double) calls these; they call the data, store and request
 * ports, so the order and the outcome are tested without a runtime.
 *
 * The export is written as one part per dataset. Each part goes to storage as it is
 * collected, so a step's result is a receipt, not the rows: a heavy subject's data
 * never has to fit in a single step result.
 */
import { LunoraError } from "@lunora/errors";

import type { ManifestDataset } from "./archive";
import { buildArchive, buildManifest, buildSummaryPdf } from "./archive";
import { articlesFor } from "./articles";
import type { Dataset } from "./dataset";
import { erasureOrder } from "./dataset";
import type { RowDisposition, VerifyResult } from "./erasure";
import { dispositionFor, drainUntilEmpty, verifyErasure } from "./erasure";
import type { RequestStatus } from "./lifecycle";
import { transition } from "./lifecycle";
import type { RequestRecord, RequestStore } from "./requests";
import type { RetentionRule } from "./rules";

/** The app's data, one dataset at a time. The app implements it over its tables. */
interface DataPort {
    /** The subject's rows for each table of the dataset, keyed by table name. */
    readonly collect: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>>;

    /**
     * Erase one batch of the dataset's rows for the subject. The package decides and the app
     * writes: call `disposition` for each row, then delete a `delete` row, anonymise an
     * `anonymise` row, and move a `keep` row into the archive table. A kept row must not be
     * selected again, or the drain never finishes.
     */
    readonly eraseBatch: (dataset: Dataset, subjectId: string, now: Date, disposition: RowDisposition) => Promise<{ readonly hasMore: boolean }>;

    /**
     * Rows still present per table after erasure, for the verify step. A row a retention rule
     * still keeps may be counted: verify checks each one against `disposition` through `collect`.
     */
    readonly remaining: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, number>>>;
}

/**
 * Where a request's files are kept between steps and in the end. `put` must key a request's
 * files under `${requestId}/`, so listing that prefix finds every file the request wrote.
 */
interface StorePort {
    /** Remove one stored object. Removing a key that is not there is not an error. */
    readonly delete: (key: string) => Promise<void>;
    /** The keys of every stored object whose key starts with the prefix. */
    readonly list: (prefix: string) => Promise<ReadonlyArray<string>>;
    readonly put: (requestId: string, file: { readonly data: Uint8Array | string; readonly name: string }) => Promise<string>;
    /** The text of a file written earlier in the same request, or `undefined` if it is not there. */
    readonly read: (requestId: string, name: string) => Promise<string | undefined>;
    /** A short-lived link to a stored file. The caller decides the lifetime, and the link is checked by the host. */
    readonly signedUrl: (key: string, ttlSeconds: number) => Promise<string>;
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

/** Delete every file a request wrote: its parts, the archive and the summary. */
const deleteRequestFiles = async (files: StorePort, request: RequestRecord): Promise<void> => {
    const keys = new Set(await files.list(`${request.id}/`));

    if (request.storageKey !== undefined) {
        keys.add(request.storageKey);
    }

    await Promise.all([...keys].map(async (key) => files.delete(key)));
};

/** The subject's key prefix for a dataset's files. An empty prefix would match every subject's files, so it is refused. */
const filesPrefixOf = (dataset: Dataset, subjectId: string): string | undefined => {
    if (dataset.files === undefined) {
        return undefined;
    }

    const prefix = dataset.files.prefix(subjectId);

    if (prefix.trim() === "") {
        throw new LunoraError("BAD_REQUEST", `Dataset "${dataset.id}" returned an empty files prefix; erasing it would delete every subject's files.`);
    }

    return prefix;
};

/**
 * Remove a request's files and, for a ready export, mark it expired in the same step, so the status
 * and the files agree. The files go first: a failed delete leaves the export ready, so the next
 * sweep or erasure retries it.
 */
const expireRequestFiles = async (context: Pick<RunContext, "files" | "now" | "store">, request: RequestRecord): Promise<void> => {
    await deleteRequestFiles(context.files, request);

    if (request.status === "ready") {
        await context.store.update(request.id, { status: transition("ready", "expired") });
        await context.store.addEvent(request.id, context.now(), "expired");
    }
};

/**
 * Delete the subject's stored files: every file each of their requests wrote, in any status,
 * and every object under each dataset's files prefix for the subject. A ready export loses its
 * files here too, so it is expired rather than left pointing at nothing.
 */
const eraseSubjectFiles = async (context: Pick<RunContext, "files" | "now" | "store">, datasets: ReadonlyArray<Dataset>, subjectId: string): Promise<void> => {
    const requests = await context.store.listForSubject(subjectId);

    await Promise.all(requests.map(async (request) => expireRequestFiles(context, request)));

    const prefixes = datasets.map((dataset) => filesPrefixOf(dataset, subjectId)).filter((prefix): prefix is string => prefix !== undefined);

    await Promise.all(
        prefixes.map(async (prefix) => {
            const keys = await context.files.list(prefix);

            await Promise.all(keys.map(async (key) => context.files.delete(key)));
        }),
    );
};

/**
 * For each retained table that still has rows, how many of them a retention rule still keeps.
 * Each row is judged again, so a row whose period has run out counts as a leftover.
 */
const keptRows = async (
    context: Pick<RunContext, "data" | "now" | "rules">,
    dataset: Dataset,
    subjectId: string,
    counts: Readonly<Record<string, number>>,
): Promise<Record<string, number>> => {
    const retained = dataset.tableNames.filter((table) => typeof dataset.tables[table]?.erase === "object" && (counts[table] ?? 0) > 0);

    if (retained.length === 0) {
        return {};
    }

    const disposition = dispositionFor(context.rules);
    const rows = await context.data.collect(dataset, subjectId);
    const now = context.now();

    return Object.fromEntries(
        retained.map((table) => [table, (rows[table] ?? []).filter((row) => disposition(dataset, table, row, now).kind === "keep").length]),
    );
};

/**
 * Read what the erasure left: rows per table, and objects per dataset with files (keyed
 * `files:` and the dataset id). The erasure is complete only when every count is zero.
 */
const verifySubjectErased = async (
    context: Pick<RunContext, "data" | "files" | "now" | "rules">,
    datasets: ReadonlyArray<Dataset>,
    subjectId: string,
): Promise<VerifyResult> => {
    const remaining: Record<string, number> = {};
    const kept: Record<string, number> = {};

    for (const dataset of datasets) {
        // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
        const counts = await context.data.remaining(dataset, subjectId);

        Object.assign(remaining, counts);

        // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
        Object.assign(kept, await keptRows(context, dataset, subjectId, counts));

        const prefix = filesPrefixOf(dataset, subjectId);

        if (prefix !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- one listing per dataset, in order
            const keys = await context.files.list(prefix);

            remaining[`files:${dataset.id}`] = keys.length;
        }
    }

    return verifyErasure(remaining, kept);
};

/** How long a finished export stays downloadable: seven days (decided, the plan's D5). */
const EXPORT_EXPIRY_MS: number = 7 * 24 * 60 * 60 * 1000;

/** A dataset is restricted (Art. 18) when a retention rule may keep any of its tables after erasure. */
const isRestricted = (dataset: Dataset): boolean => dataset.tableNames.some((table) => typeof dataset.tables[table]?.erase === "object");

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

const collectPart = async (context: RunContext, dataset: Dataset, request: RequestRecord): Promise<void> => {
    const rows = await context.data.collect(dataset, request.subjectId);
    // `omit` is applied here, not by the app: a credential column named in the dataset never reaches the archive.
    const tables = Object.fromEntries(dataset.tableNames.map((table) => [table, withoutColumns(rows[table] ?? [], dataset.tables[table]?.omit ?? [])]));

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
            restricted: isRestricted(dataset),
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
        await context.store.update(request.id, { expiresAt: new Date(context.now().getTime() + EXPORT_EXPIRY_MS), status, storageKey: archiveKey });
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

    const disposition = dispositionFor(context.rules);

    try {
        for (const dataset of erasureOrder(datasets)) {
            // Datasets erase in order, and each drain finishes before the next starts.
            // eslint-disable-next-line no-await-in-loop -- sequential by design, see the comment above
            await drainUntilEmpty(() => context.data.eraseBatch(dataset, request.subjectId, context.now(), disposition));
        }

        await eraseSubjectFiles(context, datasets, request.subjectId);

        const verdict = await verifySubjectErased(context, datasets, request.subjectId);

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

export {
    assembleExport,
    collectPart,
    type DataPort,
    deleteRequestFiles,
    eraseSubjectFiles,
    type ErasureOutcome,
    expireRequestFiles,
    type ExportOutcome,
    type RunContext,
    runErasure,
    runExport,
    type StorePort,
    verifySubjectErased,
};

export { EXPORT_EXPIRY_MS };
