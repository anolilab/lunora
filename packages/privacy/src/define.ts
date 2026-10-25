/**
 * `definePrivacy`: binds an app's datasets, presets and ports into one object the
 * app's mutations and workflows call. The methods are thin wrappers over the tested
 * services and run functions, so the Cloudflare layer only supplies ports and the
 * `defineWorkflow` registration.
 */
import { LunoraError } from "@lunora/errors";

import type { CoverageProblem } from "../../../shared/privacy-coverage";
import { checkCoverage, classifyTables } from "../../../shared/privacy-coverage";
import type { Dataset } from "./dataset";
import { erasureOrder, retainedTables } from "./dataset";
import type { DeadlinePolicy } from "./deadlines";
import { DAY_MS, DEFAULT_DEADLINES } from "./deadlines";
import { dispositionForPresets, drainUntilEmpty } from "./erasure";
import { checkErasureGraceDays, DEFAULT_ERASURE_GRACE_DAYS } from "./eu";
import { awaitsResponse, effectiveDueAt, isOverdue, isTerminal, MIN_DRAIN_BUDGET_DAYS, transition } from "./lifecycle";
import type { PrivacyPorts } from "./ports";
import type { ErasureSettings, RequestRecord, RequestStore } from "./requests";
import { cancelRequest, extendRequest, openRequest, requireRequest } from "./requests";
import type { PrivacyPolicy, PrivacyPreset } from "./rules";
import { retentionRulesOf } from "./rules";
import type { ErasureOutcome, ExportOutcome, RunScope, StepRunner } from "./run";
import { eraseDataset, erasureRun, expireRequestFiles, exportRun, inlineSteps, requireTombstones, subjectWasErased } from "./run";
import { subjectsToReerase, tombstoneKeyOf } from "./tombstones";

/**
 * Load a request the caller may act on. A request that belongs to someone else reads as
 * not found, so a caller cannot probe which ids exist.
 */
const requireOwnedRequest = async (store: RequestStore, requestId: string, subjectId: string): Promise<RequestRecord> => {
    const record = await store.get(requestId);

    if (record?.subjectId !== subjectId) {
        throw new LunoraError("NOT_FOUND", `No privacy request with id ${requestId}.`);
    }

    return record;
};

/** The app's erasure settings. An unset field takes the decided default (D3 and the sign-in window). */
type ErasureOptions = Partial<ErasureSettings>;

/**
 * The authenticated subject of a call. The app resolves it from its session, never from a request
 * argument, and passes it as the second argument of `privacyFor(ctx, identity)`, so a caller cannot
 * act on another subject's data by naming them. An operator call, a cron or a workflow passes none.
 */
interface PrivacyIdentity {
    readonly sessionAgeMs: number;
    readonly subjectId: string;
}

/**
 * Everything `definePrivacy` needs from the app. The ports depend on the invocation: a
 * mutation's `ctx.db` exists only inside that call, so `ports` runs once per call with
 * the caller's context.
 */
interface PrivacyConfig<C> {
    readonly datasets: ReadonlyArray<Dataset>;
    readonly erasure?: ErasureOptions;
    /** Tables left out of the export and erasure, each with the reason the reviewer reads. */
    readonly exclude?: Readonly<Record<string, string>>;
    readonly ports: (context: C) => PrivacyPorts;
    readonly presets?: ReadonlyArray<PrivacyPreset>;
    /** The identifier the archive shows for the subject. Defaults to the subject id itself. */
    readonly subjectKey?: (subjectId: string) => string;

    /**
     * The HMAC secret tombstone keys are derived with. Every erasure and `restore` refuse to run
     * without it and without a `tombstones` port. Keep it in a secret binding, and keep it stable,
     * because a new secret no longer matches the tombstones already written.
     */
    readonly tombstoneSecret?: string;
}

/**
 * Binds an invocation's context, and the caller's identity when the caller is a data subject, into
 * the API: `privacyFor(ctx, identity).requestExport()`. The subject methods refuse a call bound
 * without an identity; the operator methods and the workflows never read it.
 */
type PrivacyFor<C> = (context: C, identity?: PrivacyIdentity) => Privacy;

/** The step surface a Workflow handler receives. Matches the native `WorkflowStep` methods the package uses. */
interface PrivacyWorkflowContext {
    readonly params: { readonly requestId: string };
    readonly step: Required<StepRunner>;
}

/** The bound API. */
interface Privacy {
    /** Operator views and actions. Each one is for the operator's own console, not the subject. */
    readonly admin: {
        /**
         * Extend a request's deadline by the policy's further months (Art. 12(3) sentence 2). Extension
         * is the controller's decision, so it is an operator action: once per request, within the first
         * period, with the reasons the controller must give the subject.
         */
        readonly extend: (requestId: string, reason: string) => Promise<RequestRecord>;
        /** Every request that is not yet terminal. */
        readonly open: () => Promise<ReadonlyArray<RequestRecord>>;

        /**
         * Retry a failed export or erasure; any other status is refused. The Art. 12(3) clock keeps
         * running throughout. The request is moved to `processing` in this call and the result names its
         * type: the app then starts the workflow for that type, in the same mutation, and the workflow
         * resumes it. The retry itself never reads the tombstone store. Because the request leaves
         * `failed` here, a second retry is refused rather than starting a second run.
         */
        readonly retry: (requestId: string) => Promise<RetryResult>;

        /**
         * The housekeeping sweep. Run it from a cron. It expires every ready export past its download
         * window (its files go first, then it is marked `expired`), and it purges every archived row
         * whose retention period has ended through the `archive` port. Returns the expired requests
         * and how many archived rows it purged.
         */
        readonly sweep: () => Promise<SweepResult>;
    };
    readonly cancelRequest: (input: { requestId: string }) => Promise<RequestRecord>;
    readonly coverage: (tables: ReadonlyArray<string>, exclusions?: Readonly<Record<string, string>>) => ReadonlyArray<CoverageProblem>;
    /** The subject's download link for a finished export. Refused for anyone but the subject, and once expired. */
    readonly downloadUrl: (input: { requestId: string }) => Promise<string>;
    /** Every request of the subject, in every status, newest first. A finished erasure's requests no longer carry the subject's id. */
    readonly myRequests: () => Promise<ReadonlyArray<RequestRecord>>;
    readonly requestErasure: () => Promise<RequestRecord>;
    readonly requestExport: () => Promise<RequestRecord>;
    /** Erase again any restored subject that was erased after the backup. Returns the subject ids it re-erased. */
    readonly restore: (input: { restoredSubjectIds: ReadonlyArray<string> }) => Promise<ReadonlyArray<string>>;
    readonly runErasure: (requestId: string) => Promise<ErasureOutcome>;
    readonly runExport: (requestId: string) => Promise<ExportOutcome>;
    /** The deadline sweep: requests due within seven days, and those already overdue. Run it from a cron. */
    readonly tick: () => Promise<{ readonly approaching: ReadonlyArray<RequestRecord>; readonly overdue: ReadonlyArray<RequestRecord> }>;
    /** The durable handlers the app registers with `defineWorkflow`. Each step is memoised by name. */
    readonly workflows: {
        readonly erasureHandler: (context: PrivacyWorkflowContext) => Promise<void>;
        readonly exportHandler: (context: PrivacyWorkflowContext) => Promise<void>;
    };
}

/** A download link lives fifteen minutes (the plan's D5). */
const DOWNLOAD_TTL_SECONDS = 15 * 60;

const DEFAULT_FRESH_AGE_MS = DAY_MS;
/** Warn an operator this long before a request's deadline. */
const DEADLINE_WARNING_MS = 7 * DAY_MS;

/** The app's settings, resolved once by `definePrivacy` and shared by every invocation. */
interface Settings extends Omit<RunScope, "ports"> {
    readonly deadlines: DeadlinePolicy;
    readonly erasure: ErasureSettings;
    readonly exclude: Readonly<Record<string, string>>;
}

/** One invocation's view of the settings: the ports that call binds, and the caller when it is a subject. */
interface Scope extends RunScope, Settings {
    readonly identity: PrivacyIdentity | undefined;
}

/** The subject the call is bound to. A call bound without one (an operator, a cron) cannot use the subject methods. */
const callerOf = (scope: Scope): PrivacyIdentity => {
    if (scope.identity === undefined) {
        throw new LunoraError("UNAUTHENTICATED", "This privacy call is not bound to a subject: pass the caller's identity to privacyFor.");
    }

    return scope.identity;
};

/** The app's `listOpen` is filtered again, so a terminal request never reaches a sweep or a report. */
const listOpen = async (scope: Scope): Promise<ReadonlyArray<RequestRecord>> => {
    const listed = await scope.ports.store.listOpen();

    return listed.filter((record) => !isTerminal(record.status));
};

/**
 * The one-call erasure. The tombstone store and secret are checked before anything runs, so a call
 * without them is refused outright and leaves the request as it was.
 */
/** Refuses a request of the other kind, so an export run cannot erase a subject and an erasure cannot skip its grace. */
const requireType = async (scope: Scope, requestId: string, type: RequestRecord["type"]): Promise<void> => {
    const record = await requireRequest(scope.ports.store, requestId);

    if (record.type !== type) {
        throw new LunoraError("UNPROCESSABLE", `Request ${requestId} is an ${record.type}, not an ${type}.`);
    }
};

const runErasureNow = async (scope: Scope, requestId: string): Promise<ErasureOutcome> => {
    await requireType(scope, requestId, "erasure");
    requireTombstones(scope);

    return erasureRun(scope, inlineSteps, requestId);
};

/**
 * What `admin.retry` did: the request of `requestId` was moved out of `failed`, and the app must now start the
 * workflow for its `type`. Only a workflow reaches the tombstone store, so a retry never runs the request here.
 */
type RetryResult = { readonly requestId: string; readonly type: RequestRecord["type"] };

/**
 * Retry a failed request from the operator console. Only a failed request may be retried. The request moves to
 * `processing`, which the workflow's start step continues from, and the move is what refuses a second retry.
 */
const retryRequest = async (scope: Scope, requestId: string): Promise<RetryResult> => {
    const record = await requireRequest(scope.ports.store, requestId);

    if (record.status !== "failed") {
        throw new LunoraError("UNPROCESSABLE", `Only a failed request can be retried; this one is "${record.status}".`);
    }

    // An erasure rewrote this export's subject to the tombstone key; a run now would collect under that key and
    // publish an archive without the subject's data. The completed erasure shares the key, so the log shows it.
    if (record.type === "export" && (await subjectWasErased(scope.ports.store, record.subjectId))) {
        throw new LunoraError("UNPROCESSABLE", "This export's subject was erased; it cannot be retried.");
    }

    // The claim is the only gate: a second retry that read `failed` too finds the status already moved.
    if (!(await scope.ports.store.claim(requestId, "failed", { status: transition("failed", "processing") }))) {
        throw new LunoraError("UNPROCESSABLE", "This request was already retried.");
    }

    await scope.ports.store.addEvent(requestId, scope.ports.now(), "processing", "retry");

    return { requestId, type: record.type };
};

/** What `admin.sweep` did. */
interface SweepResult {
    readonly expired: ReadonlyArray<RequestRecord>;
    /** Archived rows deleted because their retention period has ended. */
    readonly purged: number;
}

/** Expire every ready export past its window. Each export's files go before its status changes, so a failed delete leaves it ready. */
const expireExports = async (scope: Scope): Promise<ReadonlyArray<RequestRecord>> => {
    const now = scope.ports.now().getTime();
    const open = await listOpen(scope);
    const due = open.filter((record) => record.status === "ready" && record.expiresAt !== undefined && record.expiresAt.getTime() < now);

    await Promise.all(due.map(async (record) => expireRequestFiles(scope.ports, record)));

    return due.map((record) => {
        return { ...record, status: "expired" as const };
    });
};

/** Whether any dataset keeps rows under a retention rule, so erasure moves rows into the archive. */
const keepsArchivedRows = (datasets: ReadonlyArray<Dataset>): boolean => datasets.some((dataset) => retainedTables(dataset).length > 0);

/**
 * Delete every archived row whose retention period has ended, one batch at a time. An app with a
 * retention rule must pass the `archive` port: without it the rows erasure kept would never go.
 */
const purgeArchive = async (scope: Scope): Promise<number> => {
    const { archive } = scope.ports;

    if (archive === undefined) {
        if (keepsArchivedRows(scope.datasets)) {
            throw new LunoraError("BAD_REQUEST", "A dataset retains rows, so the sweep needs an `archive` port to purge them once their period ends.");
        }

        return 0;
    }

    const before = scope.ports.now();
    let purged = 0;

    await drainUntilEmpty(async () => {
        const batch = await archive.purgeBatch(before);

        purged += batch.purged;

        return batch;
    });

    return purged;
};

/** Expire the finished exports, then purge the archive. An expiry is not held back by a purge failure. */
const sweep = async (scope: Scope): Promise<SweepResult> => {
    const expired = await expireExports(scope);
    const purged = await purgeArchive(scope);

    return { expired, purged };
};

/** The deadline sweep: requests due within the warning window, and those already overdue. */
const tickRequests = async (scope: Scope): Promise<{ readonly approaching: ReadonlyArray<RequestRecord>; readonly overdue: ReadonlyArray<RequestRecord> }> => {
    const at = scope.ports.now();
    const open = await listOpen(scope);
    const overdue = open.filter((record) => isOverdue(record, at));
    const approaching = open.filter((record) => {
        if (!awaitsResponse(record.status)) {
            return false;
        }

        const due = effectiveDueAt(record).getTime();

        return due - at.getTime() <= DEADLINE_WARNING_MS && due >= at.getTime();
    });

    return { approaching, overdue };
};

/** The subject's download link. A request for someone else reads as not found, and the link is refused once expired. */
const downloadUrlFor = async (scope: Scope, requestId: string): Promise<string> => {
    const record = await requireOwnedRequest(scope.ports.store, requestId, callerOf(scope).subjectId);

    if (record.type !== "export") {
        throw new LunoraError("NOT_FOUND", `No export with id ${requestId}.`);
    }

    if (record.status !== "ready" || record.storageKey === undefined) {
        throw new LunoraError("UNPROCESSABLE", "This export is not ready to download.");
    }

    if (record.expiresAt !== undefined && scope.ports.now().getTime() > record.expiresAt.getTime()) {
        throw new LunoraError("UNPROCESSABLE", "This export has expired. Request a new one.");
    }

    return scope.ports.files.signedUrl(record.storageKey, DOWNLOAD_TTL_SECONDS);
};

/** Erase again the subjects a restore brought back, each in the same dataset order as a first erasure. */
const restoreSubjects = async (scope: Scope, restoredSubjectIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
    const tombstones = requireTombstones(scope);
    const subjects = await subjectsToReerase(restoredSubjectIds, tombstones.port, tombstones.secret);

    for (const subjectId of subjects) {
        for (const dataset of erasureOrder(scope.datasets)) {
            // eslint-disable-next-line no-await-in-loop -- one drain per dataset, in order
            await eraseDataset(scope, dataset, subjectId);
        }

        // The backup also brought back the subject's request rows with their raw id; rewrite them as a first erasure does.
        const key = tombstoneKeyOf(subjectId, tombstones.secret);

        // eslint-disable-next-line no-await-in-loop -- one subject at a time, like the erasure above
        const requests = await scope.ports.store.listForSubject(subjectId);

        // eslint-disable-next-line no-await-in-loop -- one subject at a time, like the erasure above
        await Promise.all(requests.map(async (request) => scope.ports.store.update(request.id, { subjectId: key })));
    }

    return subjects;
};

/** The coverage check: every table is in a dataset or excluded with a reason. Exclusions passed here override the app's. */
const coverageOf = (scope: Scope, tables: ReadonlyArray<string>, exclusions: Readonly<Record<string, string>>): ReadonlyArray<CoverageProblem> => {
    const covered = scope.datasets.flatMap((dataset) => dataset.tableNames.map((table) => [table, dataset.id] as const));

    return checkCoverage(tables, classifyTables(covered, Object.entries({ ...scope.exclude, ...exclusions })));
};

/**
 * Bind one invocation's ports into the API. Each method is a thin call into the module-level
 * helpers above, which take the same `scope`.
 */
const bind = (settings: Settings, ports: PrivacyPorts, identity: PrivacyIdentity | undefined): Privacy => {
    const scope: Scope = { ...settings, identity, ports };

    return {
        admin: {
            extend: async (requestId, reason) => extendRequest(ports.store, { deadlines: settings.deadlines, id: requestId, now: ports.now(), reason }),
            open: async () => listOpen(scope),
            retry: async (requestId) => retryRequest(scope, requestId),
            sweep: async () => sweep(scope),
        },

        cancelRequest: async ({ requestId }) => {
            await requireOwnedRequest(ports.store, requestId, callerOf(scope).subjectId);

            return cancelRequest(ports.store, { id: requestId, now: ports.now() });
        },

        coverage: (tables, exclusions = {}) => coverageOf(scope, tables, exclusions),

        downloadUrl: async ({ requestId }) => downloadUrlFor(scope, requestId),

        myRequests: async () => {
            const requests = await ports.store.listForSubject(callerOf(scope).subjectId);

            return requests.toSorted((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        },

        requestErasure: async () => {
            const { sessionAgeMs, subjectId } = callerOf(scope);

            return openRequest(ports.store, {
                deadlines: settings.deadlines,
                erasure: settings.erasure,
                id: ports.newId(),
                now: ports.now(),
                sessionAgeMs,
                subjectId,
                type: "erasure",
            });
        },

        requestExport: async () =>
            openRequest(ports.store, {
                deadlines: settings.deadlines,
                id: ports.newId(),
                now: ports.now(),
                subjectId: callerOf(scope).subjectId,
                type: "export",
            }),

        restore: async ({ restoredSubjectIds }) => restoreSubjects(scope, restoredSubjectIds),

        runErasure: async (requestId) => runErasureNow(scope, requestId),

        runExport: async (requestId) => {
            await requireType(scope, requestId, "export");

            return exportRun(scope, inlineSteps, requestId);
        },

        tick: async () => tickRequests(scope),

        workflows: {
            erasureHandler: async (context) => {
                await requireType(scope, context.params.requestId, "erasure");
                await erasureRun(scope, context.step, context.params.requestId);
            },
            exportHandler: async (context) => {
                await requireType(scope, context.params.requestId, "export");
                await exportRun(scope, context.step, context.params.requestId);
            },
        },
    };
};

/** The value the last preset that sets `key` gives it. */
const policyValue = (presets: ReadonlyArray<PrivacyPreset> | undefined, key: keyof PrivacyPolicy): number | undefined => {
    const value = [...(presets ?? [])].toReversed().find((preset) => typeof preset.policy?.[key] === "number")?.policy?.[key];

    return typeof value === "number" ? value : undefined;
};

/** Refuse a response period that is not a whole number of months at or above `min`. */
const checkMonths = (key: string, months: number, min: number): number => {
    if (!Number.isInteger(months) || months < min) {
        throw new LunoraError("BAD_REQUEST", `The preset's ${key} must be a whole number of months, at least ${String(min)}; got ${String(months)}.`);
    }

    return months;
};

/**
 * Refuse a `retain` on a year-end rule that names no `from` column. Without `from` the period would start
 * at the erasure date, so the record would be kept for years past the one it describes.
 */
const checkRetentions = (datasets: ReadonlyArray<Dataset>, presets: ReadonlyArray<PrivacyPreset>): void => {
    const rules = retentionRulesOf(presets);

    for (const dataset of datasets) {
        for (const { directive, table } of retainedTables(dataset)) {
            const rule = rules.get(directive.rule);

            if (rule?.start === "endOfCalendarYear" && directive.from === undefined) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `Retention for ${dataset.id}.${table} uses rule "${rule.id}", which starts at the end of the record's year. Pass retain("${rule.id}", { from: "<date column>" }).`,
                );
            }
        }
    }
};

/**
 * Bind the settings into a factory. Pure construction: nothing runs until a method is
 * called, and each call of the factory binds the ports for that invocation.
 */
const definePrivacy = <C>(config: PrivacyConfig<C>): PrivacyFor<C> => {
    checkRetentions(config.datasets, config.presets ?? []);

    // Each policy value comes from the last preset that sets it; the grace may be set by the app directly.
    const presetGraceDays = policyValue(config.presets, "erasureGraceDays");
    const deadlines: DeadlinePolicy = {
        extensionMonths: checkMonths("extensionMonths", policyValue(config.presets, "extensionMonths") ?? DEFAULT_DEADLINES.extensionMonths, 0),
        responseMonths: checkMonths("responseMonths", policyValue(config.presets, "responseMonths") ?? DEFAULT_DEADLINES.responseMonths, 1),
    };

    const settings: Settings = {
        datasets: config.datasets,
        deadlines,
        disposition: dispositionForPresets(config.presets ?? []),
        erasure: {
            drainBudgetDays: config.erasure?.drainBudgetDays ?? MIN_DRAIN_BUDGET_DAYS,
            freshAgeMs: config.erasure?.freshAgeMs ?? DEFAULT_FRESH_AGE_MS,
            graceDays: checkErasureGraceDays(config.erasure?.graceDays ?? presetGraceDays ?? DEFAULT_ERASURE_GRACE_DAYS),
        },
        exclude: config.exclude ?? {},
        subjectKey: config.subjectKey ?? ((subjectId: string) => subjectId),
        tombstoneSecret: config.tombstoneSecret,
    };

    return (context, identity) => bind(settings, config.ports(context), identity);
};

export {
    definePrivacy,
    type ErasureOptions,
    type Privacy,
    type PrivacyConfig,
    type PrivacyFor,
    type PrivacyIdentity,
    type PrivacyWorkflowContext,
    type RetryResult,
    type SweepResult,
};

export { type PrivacyPorts } from "./ports";
