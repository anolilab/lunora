/**
 * The export and erasure runs, each written once as a list of named steps over a
 * {@link StepRunner}. The durable workflow passes its `step`, so each step is memoised and a
 * retry resumes at the step that failed; the one-call entries pass {@link inlineSteps}, which
 * runs each step at once. Both paths therefore share one set of lifecycle rules: the request is
 * read again before every step, so a cancel is respected wherever it lands.
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
import { DAY_MS } from "./deadlines";
import type { RowDisposition, VerifyResult } from "./erasure";
import { drainUntilEmpty, verifyErasure } from "./erasure";
import type { RequestStatus } from "./lifecycle";
import { canTransition, isTerminal, transition } from "./lifecycle";
import type { RequestRecord, RequestStore } from "./requests";
import { fromStepRecord, requireRequest, toStepRecord } from "./requests";
import type { TombstonePort } from "./tombstones";
import { tombstoneKeyOf } from "./tombstones";

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

/** The ports one invocation binds: the app's data, storage, requests and clock. */
interface PrivacyPorts {
    readonly data: DataPort;
    readonly files: StorePort;
    readonly newId: () => string;
    readonly now: () => Date;
    readonly store: RequestStore;

    /**
     * Where erased subjects are tombstoned, so a restored backup can be erased again. An erasure and
     * `restore` refuse to run without it; a call that only exports or reads may leave it out.
     */
    readonly tombstones?: TombstonePort;
}

/** What a run reads: the app's resolved settings and the ports of the invocation that runs it. */
interface RunScope {
    readonly datasets: ReadonlyArray<Dataset>;
    readonly disposition: RowDisposition;
    readonly ports: PrivacyPorts;
    readonly subjectKey: (subjectId: string) => string;
    readonly tombstoneSecret: string | undefined;
}

/**
 * How a run executes its named steps. A durable host memoises each `do` by name and retries a step
 * that throws, so every step result is JSON-safe. `sleepUntil` is the host's durable sleep; the
 * one-call path has none, so it refuses an erasure that is still inside its grace window.
 */
interface StepRunner {
    readonly do: <T>(name: string, run: () => Promise<T>) => Promise<T>;
    readonly sleepUntil?: (name: string, when: Date) => Promise<void>;
}

/** The one-call path: every step runs at once, in order. */
const inlineSteps: StepRunner = { do: async (_name, run) => run() };

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
const expireRequestFiles = async (ports: PrivacyPorts, request: RequestRecord): Promise<void> => {
    await deleteRequestFiles(ports.files, request);

    if (request.status === "ready") {
        await ports.store.update(request.id, { status: transition("ready", "expired") });
        await ports.store.addEvent(request.id, ports.now(), "expired");
    }
};

/**
 * Delete the subject's stored files: every file each of their requests wrote, in any status,
 * and every object under each dataset's files prefix for the subject. A ready export loses its
 * files here too, so it is expired rather than left pointing at nothing.
 */
const eraseSubjectFiles = async (ports: PrivacyPorts, datasets: ReadonlyArray<Dataset>, subjectId: string): Promise<void> => {
    const requests = await ports.store.listForSubject(subjectId);

    await Promise.all(requests.map(async (request) => expireRequestFiles(ports, request)));

    const prefixes = datasets.map((dataset) => filesPrefixOf(dataset, subjectId)).filter((prefix): prefix is string => prefix !== undefined);

    await Promise.all(
        prefixes.map(async (prefix) => {
            const keys = await ports.files.list(prefix);

            await Promise.all(keys.map(async (key) => ports.files.delete(key)));
        }),
    );
};

/**
 * For each retained table that still has rows, how many of them a retention rule still keeps.
 * Each row is judged again, so a row whose period has run out counts as a leftover.
 */
const keptRows = async (
    scope: Pick<RunScope, "disposition" | "ports">,
    dataset: Dataset,
    subjectId: string,
    counts: Readonly<Record<string, number>>,
): Promise<Record<string, number>> => {
    const retained = dataset.tableNames.filter((table) => typeof dataset.tables[table]?.erase === "object" && (counts[table] ?? 0) > 0);

    if (retained.length === 0) {
        return {};
    }

    const rows = await scope.ports.data.collect(dataset, subjectId);
    const now = scope.ports.now();

    return Object.fromEntries(
        retained.map((table) => [table, (rows[table] ?? []).filter((row) => scope.disposition(dataset, table, row, now).kind === "keep").length]),
    );
};

/**
 * Read what the erasure left: rows per table, and objects per dataset with files (keyed
 * `files:` and the dataset id). The erasure is complete only when every count is zero.
 */
const verifySubjectErased = async (
    scope: Pick<RunScope, "disposition" | "ports">,
    datasets: ReadonlyArray<Dataset>,
    subjectId: string,
): Promise<VerifyResult> => {
    const remaining: Record<string, number> = {};
    const kept: Record<string, number> = {};

    for (const dataset of datasets) {
        // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
        const counts = await scope.ports.data.remaining(dataset, subjectId);

        Object.assign(remaining, counts);

        // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
        Object.assign(kept, await keptRows(scope, dataset, subjectId, counts));

        const prefix = filesPrefixOf(dataset, subjectId);

        if (prefix !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- one listing per dataset, in order
            const keys = await scope.ports.files.list(prefix);

            remaining[`files:${dataset.id}`] = keys.length;
        }
    }

    return verifyErasure(remaining, kept);
};

/** How long a finished export stays downloadable: seven days (decided, the plan's D5). */
const EXPORT_EXPIRY_MS: number = 7 * DAY_MS;

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

/** Collect one dataset's rows and write them to storage. A retry overwrites the part, so it is idempotent. */
const collectPart = async (ports: PrivacyPorts, dataset: Dataset, request: RequestRecord): Promise<void> => {
    const rows = await ports.data.collect(dataset, request.subjectId);
    // `omit` is applied here, not by the app: a credential column named in the dataset never reaches the archive.
    const tables = Object.fromEntries(dataset.tableNames.map((table) => [table, withoutColumns(rows[table] ?? [], dataset.tables[table]?.omit ?? [])]));

    await ports.files.put(request.id, { data: JSON.stringify({ tables }), name: partName(dataset) });
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

/** The text a failed run records: the error message, or the value thrown when it is not an `Error`. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Record a status change and its event. Every phase writes one event, named after the status it
 * moves to, whichever path runs it.
 */
const setStatus = async (
    ports: PrivacyPorts,
    requestId: string,
    change: {
        readonly detail?: string;
        readonly from: RequestStatus;
        readonly patch?: Partial<Omit<RequestRecord, "id" | "status">>;
        readonly to: RequestStatus;
    },
): Promise<void> => {
    const status = transition(change.from, change.to);

    await ports.store.update(requestId, { ...change.patch, status });
    await ports.store.addEvent(requestId, ports.now(), status, change.detail);
};

/** The request as the run starts, through a step, so a replay sees the record the first run saw. */
const loadStep = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<RequestRecord> =>
    fromStepRecord(await steps.do("load", async () => toStepRecord(await requireRequest(scope.ports.store, requestId))));

/**
 * Move the request into `processing`, from the status it holds now, so a cancel that landed during
 * the grace or before the run is respected. A request already processing is a replayed start and
 * goes on. Returns the status the run continues from: anything but `processing` stops it.
 */
const startStep = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<RequestStatus> =>
    steps.do("start", async () => {
        const { status } = await requireRequest(scope.ports.store, requestId);

        if (status === "processing" || !canTransition(status, "processing") || status === "ready") {
            return status;
        }

        await setStatus(scope.ports, requestId, { from: status, to: "processing" });

        return "processing" as const;
    });

/** A step's answer: the status the request held when the step ran, and the step's value when it ran. */
interface Checked<T> {
    readonly status: RequestStatus;
    readonly value?: T;
}

/** Run one named step only while the request is still `processing`. A request that left it stops the run. */
const whileProcessing = async <T>(scope: RunScope, steps: StepRunner, requestId: string, name: string, run: () => Promise<T>): Promise<Checked<T>> =>
    steps.do(name, async () => {
        const { status } = await requireRequest(scope.ports.store, requestId);

        if (status !== "processing") {
            return { status };
        }

        const value: T | undefined = await run();

        // A step result is stored as JSON, so an absent value is left out rather than kept as `undefined`.
        return value === undefined ? { status } : { status, value };
    });

/** Mark the run failed and keep why on the event. A request already terminal, or failed, is left as it is. */
const failStep = async (scope: RunScope, steps: StepRunner, requestId: string, detail: string): Promise<RequestStatus> =>
    steps.do("fail", async () => {
        const { status } = await requireRequest(scope.ports.store, requestId);

        if (isTerminal(status) || !canTransition(status, "failed")) {
            return status;
        }

        await setStatus(scope.ports, requestId, { detail, from: status, to: "failed" });

        return "failed" as const;
    });

/**
 * Export the subject's data: collect each dataset as its own step, assemble, and mark the request
 * ready. A failure marks it `failed` for an operator to retry; the Art. 12(3) clock keeps running.
 */
const exportRun = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<ExportOutcome> => {
    const record = await loadStep(scope, steps, requestId);

    try {
        const started = await startStep(scope, steps, requestId);

        if (started !== "processing") {
            return { status: started };
        }

        for (const dataset of scope.datasets) {
            // Each dataset is one step: its rows go to storage, so the step returns nothing large.
            // eslint-disable-next-line no-await-in-loop -- steps run in order by design
            const collected = await whileProcessing(scope, steps, requestId, `collect:${dataset.id}`, async () => collectPart(scope.ports, dataset, record));

            if (collected.status !== "processing") {
                return { status: collected.status };
            }
        }

        const assembled = await whileProcessing(scope, steps, requestId, "assemble", async () =>
            assembleExport(scope.ports, scope.datasets, record, scope.subjectKey(record.subjectId)), );
        const archiveKey = assembled.value;

        if (archiveKey === undefined) {
            return { status: assembled.status };
        }

        const ready = await whileProcessing(scope, steps, requestId, "ready", async () =>
            setStatus(scope.ports, requestId, {
                detail: archiveKey,
                from: "processing",
                patch: { expiresAt: new Date(scope.ports.now().getTime() + EXPORT_EXPIRY_MS), storageKey: archiveKey },
                to: "ready",
            }), );

        return ready.status === "processing" ? { archiveKey, status: "ready" } : { status: ready.status };
    } catch (error) {
        return { status: await failStep(scope, steps, requestId, messageOf(error)) };
    }
};

/** The HMAC secret tombstone keys are derived with. A missing or empty secret is refused. */
const requireTombstoneSecret = (secret: string | undefined): string => {
    if (secret === undefined || secret === "") {
        throw new LunoraError("BAD_REQUEST", "Tombstones need a secret: pass `tombstoneSecret` to definePrivacy.");
    }

    return secret;
};

/**
 * The tombstone store and its secret. Every erasure needs both, and they are checked before anything
 * is erased: an erasure that could not record its tombstone would be undone by the next restore.
 */
const requireTombstones = (scope: Pick<RunScope, "ports" | "tombstoneSecret">): { readonly port: TombstonePort; readonly secret: string } => {
    const port = scope.ports.tombstones;

    if (port === undefined) {
        throw new LunoraError("BAD_REQUEST", "An erasure needs a tombstone store: pass `tombstones` in the privacy ports.");
    }

    return { port, secret: requireTombstoneSecret(scope.tombstoneSecret) };
};

/** Erase one dataset's rows for the subject, one batch at a time, until the drain finishes. */
const eraseDataset = async (scope: Pick<RunScope, "disposition" | "ports">, dataset: Dataset, subjectId: string): Promise<void> => {
    await drainUntilEmpty(() => scope.ports.data.eraseBatch(dataset, subjectId, scope.ports.now(), scope.disposition));
};

/**
 * Erase the subject's data: wait out the grace, then erase each dataset in erasure order, then the
 * stored files, then verify. The request completes only when verify finds nothing left but rows a
 * rule still keeps; otherwise it is `failed` and names the leftover tables.
 */
const erasureRun = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<ErasureOutcome> => {
    const record = await loadStep(scope, steps, requestId);

    if (record.status === "grace" && record.erasureGraceUntil !== undefined) {
        // The grace window is the subject's cancellation period: only a host that can sleep through it may run it.
        if (steps.sleepUntil === undefined) {
            throw new LunoraError("UNPROCESSABLE", "This erasure is inside its grace window. The erasure workflow runs it when the window ends.");
        }

        await steps.sleepUntil("grace", record.erasureGraceUntil);
    }

    try {
        const tombstones = requireTombstones(scope);
        const started = await startStep(scope, steps, requestId);

        if (started !== "processing") {
            return { leftover: [], status: started };
        }

        for (const dataset of erasureOrder(scope.datasets)) {
            // One drain per dataset, in erasure order. Each drain is idempotent, so a retry resumes it.
            // eslint-disable-next-line no-await-in-loop -- drains run one after another by design
            const erased = await whileProcessing(scope, steps, requestId, `erase:${dataset.id}`, async () => eraseDataset(scope, dataset, record.subjectId));

            if (erased.status !== "processing") {
                return { leftover: [], status: erased.status };
            }
        }

        const filesErased = await whileProcessing(scope, steps, requestId, "erase:files", async () =>
            eraseSubjectFiles(scope.ports, scope.datasets, record.subjectId), );

        if (filesErased.status !== "processing") {
            return { leftover: [], status: filesErased.status };
        }

        const verified = await whileProcessing(scope, steps, requestId, "verify", async () => verifySubjectErased(scope, scope.datasets, record.subjectId));
        const verdict = verified.value;

        if (verdict === undefined) {
            return { leftover: [], status: verified.status };
        }

        if (!verdict.complete) {
            return { leftover: verdict.leftover, status: await failStep(scope, steps, requestId, verdict.leftover.join(",")) };
        }

        // The tombstone is written before the request completes, so a completed erasure always has one.
        // A retried step writes it again, which the port's upsert absorbs.
        const tombstoned = await whileProcessing(scope, steps, requestId, "tombstone", async () =>
            tombstones.port.add(tombstoneKeyOf(record.subjectId, tombstones.secret), scope.ports.now()), );

        if (tombstoned.status !== "processing") {
            return { leftover: [], status: tombstoned.status };
        }

        const completed = await whileProcessing(scope, steps, requestId, "complete", async () =>
            setStatus(scope.ports, requestId, { from: "processing", to: "completed" }), );

        return { leftover: [], status: completed.status === "processing" ? "completed" : completed.status };
    } catch (error) {
        return { leftover: [], status: await failStep(scope, steps, requestId, messageOf(error)) };
    }
};

export {
    collectPart,
    type DataPort,
    eraseDataset,
    eraseSubjectFiles,
    type ErasureOutcome,
    erasureRun,
    expireRequestFiles,
    type ExportOutcome,
    exportRun,
    inlineSteps,
    type PrivacyPorts,
    requireTombstones,
    type RunScope,
    type StepRunner,
    type StorePort,
};

export { EXPORT_EXPIRY_MS };
