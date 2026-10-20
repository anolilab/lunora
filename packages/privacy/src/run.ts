/**
 * The export and erasure runs, each written once as a list of named steps over a
 * {@link StepRunner}. The durable workflow passes its `step`, so each step is memoised and a
 * retry resumes at the step that failed; the one-call entries pass {@link inlineSteps}, which
 * runs each step at once. Both paths therefore share one set of lifecycle rules: the request is
 * read again before every step, so a cancel is respected wherever it lands.
 *
 * The export is written as one part per dataset (`export.ts`). Each part goes to storage as it
 * is collected, so a step's result is a receipt, not the rows: a heavy subject's data never has to
 * fit in a single step result. The ports the runs call are declared in `ports.ts`.
 */
import { LunoraError } from "@lunora/errors";

import type { Dataset } from "./dataset";
import { erasureOrder, retainedTables } from "./dataset";
import { DAY_MS } from "./deadlines";
import type { RowDisposition, VerifyResult } from "./erasure";
import { drainUntilEmpty, verifyErasure } from "./erasure";
import { assembleExport, collectPart } from "./export";
import type { RequestStatus } from "./lifecycle";
import { canTransition, transition } from "./lifecycle";
import type { PrivacyPorts, StorePort } from "./ports";
import type { RequestRecord } from "./requests";
import { fromStepRecord, requireRequest, toStepRecord } from "./requests";
import type { TombstonePort } from "./tombstones";
import { tombstoneKeyOf } from "./tombstones";

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
 * For each table that may keep rows after erasure, how many of its remaining rows are allowed.
 * An `anonymise` table keeps every row, since an anonymised row stays in place and the package
 * cannot tell it from the original. A retained table keeps only the rows a rule still holds: each
 * row is judged again, so a row whose period has run out counts as a leftover.
 */
const allowedRows = async (
    scope: Pick<RunScope, "disposition" | "ports">,
    dataset: Dataset,
    subjectId: string,
    counts: Readonly<Record<string, number>>,
): Promise<Record<string, number>> => {
    const present = dataset.tableNames.filter((table) => (counts[table] ?? 0) > 0);
    const anonymised = present.filter((table) => dataset.tables[table]?.erase === "anonymise");
    const retained = retainedTables(dataset)
        .map(({ table }) => table)
        .filter((table) => present.includes(table));
    const allowed: Record<string, number> = Object.fromEntries(anonymised.map((table) => [table, counts[table] ?? 0]));

    if (retained.length === 0) {
        return allowed;
    }

    const rows = await scope.ports.data.collect(dataset, subjectId);
    const now = scope.ports.now();

    for (const table of retained) {
        allowed[table] = (rows[table] ?? []).filter((row) => scope.disposition(dataset, table, row, now).kind === "keep").length;
    }

    return allowed;
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
        Object.assign(kept, await allowedRows(scope, dataset, subjectId, counts));

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

        if (!canTransition(status, "processing")) {
            return status;
        }

        // A claim, not an update: a cancel that landed after the read above keeps its status, and the run stops.
        const next = transition(status, "processing");

        if (!(await scope.ports.store.claim(requestId, status, { status: next }))) {
            const current = await requireRequest(scope.ports.store, requestId);

            return current.status;
        }

        await scope.ports.store.addEvent(requestId, scope.ports.now(), next);

        return next;
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

        if (!canTransition(status, "failed")) {
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
    const step = async <T>(name: string, run: () => Promise<T>): Promise<Checked<T>> => whileProcessing(scope, steps, requestId, name, run);
    const record = await loadStep(scope, steps, requestId);

    try {
        const started = await startStep(scope, steps, requestId);

        if (started !== "processing") {
            return { status: started };
        }

        for (const dataset of scope.datasets) {
            // Each dataset is one step: its rows go to storage, so the step returns nothing large.
            // eslint-disable-next-line no-await-in-loop -- steps run in order by design
            const collected = await step(`collect:${dataset.id}`, async () => collectPart(scope.ports, dataset, record));

            if (collected.status !== "processing") {
                return { status: collected.status };
            }
        }

        const assembled = await step("assemble", async () => assembleExport(scope.ports, scope.datasets, record, scope.subjectKey(record.subjectId)));
        const archiveKey = assembled.value;

        if (archiveKey === undefined) {
            return { status: assembled.status };
        }

        const markReady = async (): Promise<void> => {
            const patch = { expiresAt: new Date(scope.ports.now().getTime() + EXPORT_EXPIRY_MS), storageKey: archiveKey };

            await setStatus(scope.ports, requestId, { detail: archiveKey, from: "processing", patch, to: "ready" });
        };
        const ready = await step("ready", markReady);

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
 * Complete an erasure and drop the raw subject id from the request log: every request of the subject,
 * this one last, takes the tombstone key as its `subjectId`, so the log keeps the link the tombstone
 * keeps and nothing more. A retry finds the requests already rewritten and only completes this one.
 * The subject's own lookups by their id stop finding these requests, which is the point.
 */
const completeErasure = async (ports: PrivacyPorts, requestId: string, subjectId: string, key: string): Promise<void> => {
    const requests = await ports.store.listForSubject(subjectId);
    const others = requests.filter((request) => request.id !== requestId);

    await Promise.all(others.map(async (request) => ports.store.update(request.id, { subjectId: key })));
    await setStatus(ports, requestId, { from: "processing", patch: { subjectId: key }, to: "completed" });
};

/**
 * Erase the subject's data: wait out the grace, then erase each dataset in erasure order, then the
 * stored files, then verify. The request completes only when verify finds nothing left but rows a
 * rule still keeps; otherwise it is `failed` and names the leftover tables.
 */
const erasureRun = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<ErasureOutcome> => {
    const step = async <T>(name: string, run: () => Promise<T>): Promise<Checked<T>> => whileProcessing(scope, steps, requestId, name, run);
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

        // The tombstone is written first: before anything is erased, so a store that cannot take it
        // (unbound behind the workflow's port, or failing) stops the erasure with nothing deleted, and
        // before the request completes, so a completed erasure always has one. A retried step writes it
        // again, which the port's upsert absorbs.
        const key = tombstoneKeyOf(record.subjectId, tombstones.secret);
        const tombstoned = await step("tombstone", async () => tombstones.port.add(key, scope.ports.now()));

        if (tombstoned.status !== "processing") {
            return { leftover: [], status: tombstoned.status };
        }

        for (const dataset of erasureOrder(scope.datasets)) {
            // One drain per dataset, in erasure order. Each drain is idempotent, so a retry resumes it.
            // eslint-disable-next-line no-await-in-loop -- drains run one after another by design
            const erased = await step(`erase:${dataset.id}`, async () => eraseDataset(scope, dataset, record.subjectId));

            if (erased.status !== "processing") {
                return { leftover: [], status: erased.status };
            }
        }

        const filesErased = await step("erase:files", async () => eraseSubjectFiles(scope.ports, scope.datasets, record.subjectId));

        if (filesErased.status !== "processing") {
            return { leftover: [], status: filesErased.status };
        }

        const verified = await step("verify", async () => verifySubjectErased(scope, scope.datasets, record.subjectId));
        const verdict = verified.value;

        if (verdict === undefined) {
            return { leftover: [], status: verified.status };
        }

        if (!verdict.complete) {
            return { leftover: verdict.leftover, status: await failStep(scope, steps, requestId, verdict.leftover.join(",")) };
        }

        const completed = await step("complete", async () => completeErasure(scope.ports, requestId, record.subjectId, key));

        return { leftover: [], status: completed.status === "processing" ? "completed" : completed.status };
    } catch (error) {
        return { leftover: [], status: await failStep(scope, steps, requestId, messageOf(error)) };
    }
};

export {
    eraseDataset,
    type ErasureOutcome,
    erasureRun,
    expireRequestFiles,
    type ExportOutcome,
    exportRun,
    inlineSteps,
    requireTombstones,
    type RunScope,
    setStatus,
    type StepRunner,
};
