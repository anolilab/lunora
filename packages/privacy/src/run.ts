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
import { erasureOrder, PortTableMissingError, requireTables, retainedTables } from "./dataset";
import { DAY_MS } from "./deadlines";
import type { RowDisposition, VerifyResult } from "./erasure";
import { drainUntilEmpty, verifyErasure } from "./erasure";
import { assembleExport, collectPart } from "./export";
import type { RequestStatus } from "./lifecycle";
import { canTransition, transition } from "./lifecycle";
import type { PrivacyPorts, StorePort } from "./ports";
import { isUnboundPort } from "./ports";
import type { RequestRecord, RequestStore } from "./requests";
import { requireRequest } from "./requests";
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

/**
 * The key prefix of one export run's files. A run id is a single path segment (see the `run` step), so the prefix
 * names that run and no other: `foo` does not match the files of a run whose id is `other/foo/bar`.
 */
const runPrefixOf = (requestId: string, runId: string): string => `${requestId}/${runId}/`;

/** The id an export run names its files with. An app's `newId` that returns a path would break the prefix rule above. */
const runIdOf = (id: string): string => {
    if (id === "" || id.includes("/")) {
        throw new LunoraError("INTERNAL", "newId must return a non-empty id without a `/`.");
    }

    return id;
};

/** Delete the files one export run wrote under the request. Returns how many. */
const deleteRunFiles = async (files: StorePort, requestId: string, runId: string): Promise<number> => {
    const keys = await files.list(runPrefixOf(requestId, runId));

    await Promise.all(keys.map(async (key) => files.delete(key)));

    return keys.length;
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

    requireTables(rows, dataset, "collect");

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

        requireTables(counts, dataset, "remaining");
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

/**
 * The detail a failed run records. Only the error's code: a message can carry a subject's values (an id, a
 * column value), and the event log is read by people who should not see them. The one exception is a missing
 * dataset table, whose message holds schema names only, so the event can say which table the port left out.
 */
const failureDetail = (error: unknown): string => {
    if (error instanceof PortTableMissingError) {
        return `INTERNAL: the data port returned no entry for table "${error.table}" of dataset "${error.dataset}"`;
    }

    return `${error instanceof LunoraError ? error.code : "INTERNAL"}: the run stopped before it finished`;
};

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

/**
 * What the run reads before its first step. The subject is not here: every step reads the request again and takes
 * the subject from that read, so the step log never holds a raw subject id.
 */
type LoadedRequest = Pick<RequestRecord, "erasureGraceUntil" | "id" | "status" | "type">;

/** The request as the run starts, through a step, so a replay sees the record the first run saw. */
const loadStep = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<LoadedRequest> => {
    const loaded = await steps.do("load", async () => {
        const record = await requireRequest(scope.ports.store, requestId);

        return {
            id: record.id,
            status: record.status,
            type: record.type,
            ...(record.erasureGraceUntil === undefined ? {} : { erasureGraceUntil: record.erasureGraceUntil.toISOString() }),
        };
    });
    const { erasureGraceUntil, ...rest } = loaded;

    return erasureGraceUntil === undefined ? rest : { ...rest, erasureGraceUntil: new Date(erasureGraceUntil) };
};

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
const whileProcessing = async <T>(
    scope: RunScope,
    steps: StepRunner,
    requestId: string,
    name: string,
    run: (request: RequestRecord) => Promise<T>,
): Promise<Checked<T>> =>
    steps.do(name, async () => {
        const request = await requireRequest(scope.ports.store, requestId);

        if (request.status !== "processing") {
            return { status: request.status };
        }

        const value: T | undefined = await run(request);

        // A step result is stored as JSON, so an absent value is left out rather than kept as `undefined`.
        return value === undefined ? { status: request.status } : { status: request.status, value };
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

/** The erasure statuses that block an export of the subject: its data is partly or wholly gone, or the subject was erased. */
const ERASURE_BLOCKING: ReadonlySet<RequestStatus> = new Set(["completed", "failed", "processing"]);

/**
 * Whether the subject's erasure has begun or completed, read from the subject's request records. An erasure that is
 * processing or failed has deleted some of the data and still carries the raw id, so its own record finds it. A completed
 * erasure has re-keyed the subject's requests to the tombstone key, so the requests that carry that key find it.
 */
const subjectErasureBlocks = async (store: RequestStore, subjectId: string): Promise<boolean> => {
    const requests = await store.listForSubject(subjectId);

    return requests.some((request) => request.type === "erasure" && ERASURE_BLOCKING.has(request.status));
};

/**
 * Whether an erasure of the subject has begun or completed, found from the request store alone. A completed erasure rekeys its
 * requests to the tombstone key, so the raw id misses it: the key is derived from the secret, so this needs no tombstone port and
 * runs wherever the secret is set. Without a secret no erasure can have completed (`requireTombstones` refuses one), so only the raw
 * id is read.
 */
const erasureBlocksSubject = async (store: RequestStore, subjectId: string, secret: string | undefined): Promise<boolean> => {
    if (await subjectErasureBlocks(store, subjectId)) {
        return true;
    }

    if (secret === undefined || secret === "") {
        return false;
    }

    return subjectErasureBlocks(store, tombstoneKeyOf(subjectId, secret));
};

/**
 * Export the subject's data: collect each dataset as its own step, assemble, and mark the request
 * ready. A failure marks it `failed` for an operator to retry; the Art. 12(3) clock keeps running.
 *
 * Every path checks the request store for a begun or completed erasure (`erasureBlocksSubject`). `tombstones` is passed by the
 * workflow only. Its probe answers for a request an erasure re-keyed, whose erasure may no longer be found under its key; a fresh
 * request carries the raw id, which no tombstone matches. The one-call path cannot reach the tombstone store from a mutation, so it
 * does not pass one; it refuses a failed export, and `admin.retry` sends those to the workflow.
 */
const exportRun = async (scope: RunScope, steps: StepRunner, requestId: string, tombstones?: TombstonePort): Promise<ExportOutcome> => {
    const step = async <T>(name: string, run: (request: RequestRecord) => Promise<T>): Promise<Checked<T>> =>
        whileProcessing(scope, steps, requestId, name, run);
    let runId: string | undefined;

    // A run that stops after writing removes what it wrote, and only that: another run of the export keeps its files.
    // A ready request may point at this run's archive (a throw after the ready write lands here as `ready`), so the
    // files stay only when the request's live archive is this run's own. A run that wrote nothing has nothing to remove.
    const stop = async (status: RequestStatus): Promise<ExportOutcome> => {
        const id = runId;

        if (id === undefined) {
            return { status };
        }

        return steps.do("discard", async (): Promise<ExportOutcome> => {
            const current = status === "ready" ? await requireRequest(scope.ports.store, requestId) : undefined;
            const live = current?.storageKey;

            if (live?.startsWith(runPrefixOf(requestId, id)) === true) {
                return { status };
            }

            await deleteRunFiles(scope.ports.files, requestId, id);

            return live === undefined ? { status } : { archiveKey: live, status };
        });
    };

    const loaded = await loadStep(scope, steps, requestId);

    if (tombstones === undefined && loaded.status === "failed") {
        throw new LunoraError("UNPROCESSABLE", "A failed export is retried through admin.retry, which starts its workflow.");
    }

    try {
        const started = await startStep(scope, steps, requestId);

        if (started !== "processing") {
            return { status: started };
        }

        // Checked after the claim: a failed export that an erasure re-keyed can be claimed later, and by then its tombstone key
        // is on record. Checking before the claim would let such a run collect under that key and publish an empty archive.
        const erased = await steps.do("erased", async () => {
            const { subjectId } = await requireRequest(scope.ports.store, requestId);

            if (await erasureBlocksSubject(scope.ports.store, subjectId, scope.tombstoneSecret)) {
                return true;
            }

            // The tombstone is keyed by HMAC. A request an erasure re-keyed carries that key, so the probe asks for it as stored.
            // A request that still carries the raw id is probed under its HMAC too: a restore can roll back the erasure request
            // the store check relies on, and the tombstone survives the restore.
            if (tombstones === undefined || scope.tombstoneSecret === undefined || scope.tombstoneSecret === "") {
                return false;
            }

            try {
                if (await tombstones.has(subjectId)) {
                    return true;
                }

                return await tombstones.has(tombstoneKeyOf(subjectId, scope.tombstoneSecret));
            } catch (error) {
                // An app with no tombstone store leaves the port unbound, so the answer is "not tombstoned". Only that error
                // is absorbed: the request store check above has already run, and any other failure stops the export.
                if (isUnboundPort(error, "tombstones")) {
                    return false;
                }

                throw error;
            }
        });

        if (erased) {
            return { status: await failStep(scope, steps, requestId, "UNPROCESSABLE: the subject's erasure has begun or completed") };
        }

        // Every file this run writes is named under its own id, journaled so a replay keeps it. The id is one path segment:
        // a `/` in it would let this run's prefix contain another run's files.
        runId = await steps.do("run", () => Promise.resolve(runIdOf(scope.ports.newId())));

        const ownId = runId;

        for (const dataset of scope.datasets) {
            // Each dataset is one step: its rows go to storage, so the step returns nothing large.
            // eslint-disable-next-line no-await-in-loop -- steps run in order by design
            const collected = await step(`collect:${dataset.id}`, async (request) => collectPart(scope.ports, dataset, request, ownId));

            if (collected.status !== "processing") {
                // eslint-disable-next-line no-await-in-loop -- the run ends here
                return await stop(collected.status);
            }
        }

        const assemble = async (request: RequestRecord): Promise<string> =>
            assembleExport(scope.ports, scope.datasets, request, scope.subjectKey(request.subjectId), ownId);
        const assembled = await step("assemble", assemble);
        const archiveKey = assembled.value;

        if (archiveKey === undefined) {
            return await stop(assembled.status);
        }

        // A claim, not an update: an erasure that fails this export after the step's read must not be written
        // over, and the archive this run wrote holds data that erasure removed, so its files go too.
        const ready = await step("ready", async (): Promise<ExportOutcome> => {
            const status = transition("processing", "ready");
            const patch = { expiresAt: new Date(scope.ports.now().getTime() + EXPORT_EXPIRY_MS), status, storageKey: archiveKey };

            if (await scope.ports.store.claim(requestId, "processing", patch)) {
                await scope.ports.store.addEvent(requestId, scope.ports.now(), status, archiveKey);

                return { archiveKey, status };
            }

            // The ready request answers with its archive. When that archive is this run's own (a retried step
            // whose claim had already landed), the files stay; any other run's archive was never this run's to keep.
            const current = await requireRequest(scope.ports.store, requestId);
            const live = current.status === "ready" ? current.storageKey : undefined;

            if (live?.startsWith(runPrefixOf(requestId, ownId)) !== true) {
                await deleteRunFiles(scope.ports.files, requestId, ownId);
            }

            return live === undefined ? { status: current.status } : { archiveKey: live, status: current.status };
        });

        // No value means the step's callback never ran: the request had already left `processing`.
        return ready.value ?? (await stop(ready.status));
    } catch (error) {
        return await stop(await failStep(scope, steps, requestId, failureDetail(error)));
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
 * Fail a request that has not finished, from whatever status it holds when the claim lands. A run may move it
 * between the caller's read and the claim (`received` to `processing`); each lost claim re-reads the status,
 * and statuses only move forward, so this ends.
 */
const failOpenRequest = async (ports: PrivacyPorts, request: RequestRecord, detail: string): Promise<void> => {
    let { status } = request;

    while (canTransition(status, "failed")) {
        // eslint-disable-next-line no-await-in-loop -- each claim depends on the status the last one lost to
        if (await ports.store.claim(request.id, status, { status: transition(status, "failed") })) {
            // eslint-disable-next-line no-await-in-loop -- the event follows the claim that won
            await ports.store.addEvent(request.id, ports.now(), "failed", detail);

            return;
        }

        // eslint-disable-next-line no-await-in-loop -- the next claim needs the fresh status
        const current = await ports.store.get(request.id);

        if (current === undefined || current.status === status) {
            return;
        }

        status = current.status;
    }
};

/**
 * Complete an erasure and drop the raw subject id from the request log: every request of the subject,
 * this one last, takes the tombstone key as its `subjectId`, so the log keeps the link the tombstone
 * keeps and nothing more. A retry finds the requests already rewritten and only completes this one.
 * The subject's own lookups by their id stop finding these requests, which is the point.
 *
 * An export not yet finished, queued or processing, is failed in the same write: its later steps would read
 * the tombstone key as the subject and assemble an archive missing the data not yet collected. The claim
 * keeps a run that moved on meanwhile from being written over. The export's start and ready steps claim
 * too, so whichever claim lands first wins: an export failed here never turns ready, and one that turned
 * ready first is expired here. A queued export's run then finds the erasure and stops (see `exportRun`).
 */
const completeErasure = async (ports: PrivacyPorts, requestId: string, subjectId: string, key: string): Promise<void> => {
    const requests = await ports.store.listForSubject(subjectId);
    const others = requests.filter((request) => request.id !== requestId);

    // The rekey is each request's last write: until its cleanup has succeeded the request stays under the subject's
    // id, so a retried erasure lists it again and finishes the cleanup, which is safe to repeat.
    await Promise.all(
        others.map(async (request) => {
            // Only an export is failed: another erasure of the subject is a request this one does not own.
            if (request.type === "export") {
                await failOpenRequest(ports, request, "UNPROCESSABLE: the subject was erased before the export finished");
            }

            const current = (await ports.store.get(request.id)) ?? request;

            if (current.status === "ready") {
                // An export that went ready after the files step holds data this erasure removed, so it expires here.
                await expireRequestFiles(ports, current);
            } else if (current.type === "export" && current.status === "failed") {
                // A failed export's runs are stopped, so all of its files go; a run still writing removes its own.
                await deleteRequestFiles(ports.files, current);
            }

            await ports.store.update(request.id, { subjectId: key });

            // A run that claimed after the reads above still holds the raw subject id, so its data may be gone. Recheck the rekeyed
            // request: a processing export is failed, and one that went ready meanwhile is expired.
            const rekeyed = (await ports.store.get(request.id)) ?? current;

            if (rekeyed.type === "export" && rekeyed.status === "processing") {
                await failOpenRequest(ports, rekeyed, "UNPROCESSABLE: the subject was erased before the export finished");
            } else if (rekeyed.status === "ready" && current.status !== "ready") {
                await expireRequestFiles(ports, rekeyed);
            }
        }),
    );
    await setStatus(ports, requestId, { from: "processing", patch: { subjectId: key }, to: "completed" });
};

/**
 * Erase the subject's data: wait out the grace, then erase each dataset in erasure order, then the
 * stored files, then verify. The request completes only when verify finds nothing left but rows a
 * rule still keeps; otherwise it is `failed` and names the leftover tables.
 */
const erasureRun = async (scope: RunScope, steps: StepRunner, requestId: string): Promise<ErasureOutcome> => {
    const step = async <T>(name: string, run: (request: RequestRecord) => Promise<T>): Promise<Checked<T>> =>
        whileProcessing(scope, steps, requestId, name, run);
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
        const keyOf = (request: RequestRecord): string => tombstoneKeyOf(request.subjectId, tombstones.secret);
        const tombstoned = await step("tombstone", async (request) => tombstones.port.add(keyOf(request), scope.ports.now()));

        if (tombstoned.status !== "processing") {
            return { leftover: [], status: tombstoned.status };
        }

        for (const dataset of erasureOrder(scope.datasets)) {
            // One drain per dataset, in erasure order. Each drain is idempotent, so a retry resumes it.
            // eslint-disable-next-line no-await-in-loop -- drains run one after another by design
            const erased = await step(`erase:${dataset.id}`, async (request) => eraseDataset(scope, dataset, request.subjectId));

            if (erased.status !== "processing") {
                return { leftover: [], status: erased.status };
            }
        }

        const filesErased = await step("erase:files", async (request) => eraseSubjectFiles(scope.ports, scope.datasets, request.subjectId));

        if (filesErased.status !== "processing") {
            return { leftover: [], status: filesErased.status };
        }

        const verified = await step("verify", async (request) => verifySubjectErased(scope, scope.datasets, request.subjectId));
        const verdict = verified.value;

        if (verdict === undefined) {
            return { leftover: [], status: verified.status };
        }

        if (!verdict.complete) {
            return { leftover: verdict.leftover, status: await failStep(scope, steps, requestId, verdict.leftover.join(",")) };
        }

        const completed = await step("complete", async (request) => completeErasure(scope.ports, requestId, request.subjectId, keyOf(request)));

        return { leftover: [], status: completed.status === "processing" ? "completed" : completed.status };
    } catch (error) {
        return { leftover: [], status: await failStep(scope, steps, requestId, failureDetail(error)) };
    }
};

export {
    eraseDataset,
    erasureBlocksSubject,
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
    subjectErasureBlocks,
};
