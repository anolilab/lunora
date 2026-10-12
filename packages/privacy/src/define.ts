/**
 * `definePrivacy`: binds an app's datasets, presets and ports into one object the
 * app's mutations and workflows call. The methods are thin wrappers over the tested
 * services and run functions, so the Cloudflare layer only supplies ports and the
 * `defineWorkflow` registration.
 */
import { LunoraError } from "@lunora/errors";

import type { CoverageProblem, TableClassification } from "./coverage";
import { checkCoverage } from "./coverage";
import type { Dataset } from "./dataset";
import { erasureOrder } from "./dataset";
import { DAY_MS } from "./deadlines";
import { dispositionFor } from "./erasure";
import { checkErasureGraceDays, DEFAULT_ERASURE_GRACE_DAYS } from "./eu";
import { awaitsResponse, effectiveDueAt, isOverdue, isTerminal, MIN_DRAIN_BUDGET_DAYS } from "./lifecycle";
import type { ErasureSettings, RequestRecord, RequestStore } from "./requests";
import { cancelRequest, extendRequest, openRequest, requireRequest } from "./requests";
import type { PrivacyPreset, RetentionRule } from "./rules";
import type { ErasureOutcome, ExportOutcome, PrivacyPorts, RunScope, StepRunner } from "./run";
import { eraseDataset, erasureRun, expireRequestFiles, exportRun, inlineSteps, requireTombstones } from "./run";
import { subjectsToReerase } from "./tombstones";

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
        /** Re-run a failed export or erasure. The Art. 12(3) clock keeps running throughout. */
        readonly retry: (requestId: string) => Promise<ExportOutcome | ErasureOutcome>;

        /**
         * Expire every ready export past its download window: delete its files, then mark it
         * `expired`. Returns the requests it expired. Run it from a cron.
         */
        readonly sweep: () => Promise<ReadonlyArray<RequestRecord>>;
    };
    readonly cancelRequest: (input: { requestId: string }) => Promise<RequestRecord>;
    readonly coverage: (tables: ReadonlyArray<string>, exclusions?: Readonly<Record<string, string>>) => ReadonlyArray<CoverageProblem>;
    /** The subject's download link for a finished export. Refused for anyone but the subject, and once expired. */
    readonly downloadUrl: (input: { requestId: string }) => Promise<string>;
    /** The subject's own requests that are still open. */
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
const runErasureNow = async (scope: Scope, requestId: string): Promise<ErasureOutcome> => {
    requireTombstones(scope);

    return erasureRun(scope, inlineSteps, requestId);
};

/** Re-run a failed export or erasure from the operator console. Only a failed request may be retried. */
const retryRequest = async (scope: Scope, requestId: string): Promise<ExportOutcome | ErasureOutcome> => {
    const record = await requireRequest(scope.ports.store, requestId);

    if (record.status !== "failed") {
        throw new LunoraError("UNPROCESSABLE", `Only a failed request can be retried; this one is "${record.status}".`);
    }

    return record.type === "export" ? exportRun(scope, inlineSteps, requestId) : runErasureNow(scope, requestId);
};

/** Expire every ready export past its window. Each export's files go before its status changes, so a failed delete leaves it ready. */
const sweepExpired = async (scope: Scope): Promise<ReadonlyArray<RequestRecord>> => {
    const now = scope.ports.now().getTime();
    const open = await listOpen(scope);
    const due = open.filter((record) => record.status === "ready" && record.expiresAt !== undefined && record.expiresAt.getTime() < now);

    await Promise.all(due.map(async (record) => expireRequestFiles(scope.ports, record)));

    return due.map((record) => {
        return { ...record, status: "expired" as const };
    });
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

        const due = effectiveDueAt(record.receivedAt, record.extendedDueAt !== undefined).getTime();

        return due - at.getTime() <= DEADLINE_WARNING_MS && due >= at.getTime();
    });

    return { approaching, overdue };
};

/** The subject's download link. A request for someone else reads as not found, and the link is refused once expired. */
const downloadUrlFor = async (scope: Scope, requestId: string): Promise<string> => {
    const { subjectId } = callerOf(scope);
    const record = await requireRequest(scope.ports.store, requestId);

    if (record.subjectId !== subjectId || record.type !== "export") {
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
    }

    return subjects;
};

/** The coverage check: every table is in a dataset or excluded with a reason. Exclusions passed here override the app's. */
const coverageOf = (scope: Scope, tables: ReadonlyArray<string>, exclusions: Readonly<Record<string, string>>): ReadonlyArray<CoverageProblem> => {
    const allExclusions = { ...scope.exclude, ...exclusions };
    const classifications: Record<string, TableClassification | undefined> = {};

    for (const dataset of scope.datasets) {
        for (const table of dataset.tableNames) {
            classifications[table] = { dataset: dataset.id };
        }
    }

    for (const [table, reason] of Object.entries(allExclusions)) {
        classifications[table] = { excluded: reason };
    }

    return checkCoverage(tables, classifications);
};

/**
 * Bind one invocation's ports into the API. Each method is a thin call into the module-level
 * helpers above, which take the same `scope`.
 */
const bind = (settings: Settings, ports: PrivacyPorts, identity: PrivacyIdentity | undefined): Privacy => {
    const scope: Scope = { ...settings, identity, ports };

    return {
        admin: {
            extend: async (requestId, reason) => extendRequest(ports.store, { id: requestId, now: ports.now(), reason }),
            open: async () => listOpen(scope),
            retry: async (requestId) => retryRequest(scope, requestId),
            sweep: async () => sweepExpired(scope),
        },

        cancelRequest: async ({ requestId }) => {
            await requireOwnedRequest(ports.store, requestId, callerOf(scope).subjectId);

            return cancelRequest(ports.store, { id: requestId, now: ports.now() });
        },

        coverage: (tables, exclusions = {}) => coverageOf(scope, tables, exclusions),

        downloadUrl: async ({ requestId }) => downloadUrlFor(scope, requestId),

        myRequests: async () => {
            const { subjectId } = callerOf(scope);
            const open = await listOpen(scope);

            return open.filter((record) => record.subjectId === subjectId);
        },

        requestErasure: async () => {
            const { sessionAgeMs, subjectId } = callerOf(scope);

            return openRequest(ports.store, { erasure: settings.erasure, id: ports.newId(), now: ports.now(), sessionAgeMs, subjectId, type: "erasure" });
        },

        requestExport: async () => openRequest(ports.store, { id: ports.newId(), now: ports.now(), subjectId: callerOf(scope).subjectId, type: "export" }),

        restore: async ({ restoredSubjectIds }) => restoreSubjects(scope, restoredSubjectIds),

        runErasure: async (requestId) => runErasureNow(scope, requestId),

        runExport: async (requestId) => exportRun(scope, inlineSteps, requestId),

        tick: async () => tickRequests(scope),

        workflows: {
            erasureHandler: async (context) => {
                await erasureRun(scope, context.step, context.params.requestId);
            },
            exportHandler: async (context) => {
                await exportRun(scope, context.step, context.params.requestId);
            },
        },
    };
};

/**
 * Bind the settings into a factory. Pure construction: nothing runs until a method is
 * called, and each call of the factory binds the ports for that invocation.
 */
const definePrivacy = <C>(config: PrivacyConfig<C>): PrivacyFor<C> => {
    const rules = new Map<string, RetentionRule>();

    for (const preset of config.presets ?? []) {
        for (const rule of preset.retention) {
            rules.set(rule.id, rule);
        }
    }

    // The grace comes from the preset that sets one, unless the app sets it directly.
    const presetGraceDays = [...(config.presets ?? [])].toReversed().find((preset) => preset.policy?.erasureGraceDays !== undefined)?.policy?.erasureGraceDays;

    const settings: Settings = {
        datasets: config.datasets,
        disposition: dispositionFor(rules),
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

export { definePrivacy, type ErasureOptions, type Privacy, type PrivacyConfig, type PrivacyFor, type PrivacyIdentity, type PrivacyWorkflowContext };

export { type PrivacyPorts } from "./run";
