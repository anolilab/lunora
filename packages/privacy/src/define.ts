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
import { drainUntilEmpty, verifyErasure } from "./erasure";
import { checkErasureGraceDays, DEFAULT_ERASURE_GRACE_DAYS } from "./eu";
import type { RequestStatus } from "./lifecycle";
import { effectiveDueAt, isOverdue, transition } from "./lifecycle";
import type { RequestRecord, RequestStore } from "./requests";
import { cancelRequest, extendRequest, openRequest } from "./requests";
import type { PrivacyPreset, RetentionRule } from "./rules";
import type { DataPort, ErasureOutcome, ExportOutcome, RunContext, StorePort } from "./run";
import { assembleExport, collectPart, EXPORT_EXPIRY_MS, runErasure, runExport } from "./run";
import type { TombstonePort } from "./tombstones";
import { subjectsToReerase, tombstoneKeyOf } from "./tombstones";

/** The app's erasure settings. The defaults are the decided values (D3 and the sign-in window). */
interface ErasureOptions {
    readonly drainBudgetDays?: number;
    readonly freshAgeMs?: number;
    readonly graceDays?: number;
}

/** The ports one invocation binds: the app's data, storage, requests and clock. */
interface PrivacyPorts {
    readonly data: DataPort;
    readonly files: StorePort;
    readonly newId: () => string;
    readonly now: () => Date;
    readonly store: RequestStore;
    /** Where erased subjects are tombstoned, so a restored backup can be erased again. Optional; `restore` needs it. */
    readonly tombstones?: TombstonePort;
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
}

/** Binds an invocation's context into the API. Call it once per invocation: `privacyFor(ctx).requestExport(...)`. */
type PrivacyFor<C> = (context: C) => Privacy;

/** The step surface a Workflow handler receives. Matches the native `WorkflowStep` methods the package uses. */
interface PrivacyWorkflowContext {
    readonly params: { readonly requestId: string };
    readonly step: {
        readonly do: <T>(name: string, run: () => Promise<T>) => Promise<T>;
        readonly sleepUntil: (name: string, when: Date) => Promise<void>;
    };
}

/** The bound API. */
interface Privacy {
    /** Operator views and actions. Each one is for the operator's own console, not the subject. */
    readonly admin: {
        /** Every request that is not yet terminal. */
        readonly open: () => Promise<ReadonlyArray<RequestRecord>>;
        /** Re-run a failed export or erasure. The Art. 12(3) clock keeps running throughout. */
        readonly retry: (requestId: string) => Promise<ExportOutcome | ErasureOutcome>;
    };
    readonly cancelRequest: (input: { requestId: string }) => Promise<RequestRecord>;
    readonly coverage: (tables: ReadonlyArray<string>, exclusions?: Readonly<Record<string, string>>) => ReadonlyArray<CoverageProblem>;
    /** The subject's download link for a finished export. Refused for anyone but the subject, and once expired. */
    readonly downloadUrl: (input: { requestId: string; subjectId: string }) => Promise<string>;
    readonly extendRequest: (input: { reason: string; requestId: string }) => Promise<RequestRecord>;
    readonly requestErasure: (input: { sessionAgeMs: number; subjectId: string }) => Promise<RequestRecord>;
    readonly requestExport: (input: { subjectId: string }) => Promise<RequestRecord>;
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

const DEFAULT_GRACE_DAYS = DEFAULT_ERASURE_GRACE_DAYS;
const DEFAULT_DRAIN_BUDGET_DAYS = 3;
const DEFAULT_FRESH_AGE_MS = 24 * 60 * 60 * 1000;
/** Warn an operator this long before a request's deadline. */
const DEADLINE_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

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

    const erasure = {
        drainBudgetDays: config.erasure?.drainBudgetDays ?? DEFAULT_DRAIN_BUDGET_DAYS,
        freshAgeMs: config.erasure?.freshAgeMs ?? DEFAULT_FRESH_AGE_MS,
        graceDays: checkErasureGraceDays(config.erasure?.graceDays ?? presetGraceDays ?? DEFAULT_GRACE_DAYS),
    };
    const subjectKey = config.subjectKey ?? ((subjectId: string) => subjectId);

    const bind = (ports: PrivacyPorts): Privacy => {
        const base = { data: ports.data, files: ports.files, now: ports.now, rules, store: ports.store };

        const eraseDataset = async (dataset: Dataset, subjectId: string): Promise<void> => {
            await drainUntilEmpty(() => ports.data.eraseBatch(dataset, subjectId, ports.now()));
        };

        const contextFor = (record: RequestRecord): RunContext => {
            return { ...base, subjectKey: subjectKey(record.subjectId) };
        };

        const requireRequest = async (requestId: string): Promise<RequestRecord> => {
            const record = await ports.store.get(requestId);

            if (record === undefined) {
                throw new LunoraError("NOT_FOUND", `No privacy request with id ${requestId}.`);
            }

            return record;
        };

        const setStatus = async (record: RequestRecord, status: RequestStatus, detail?: string): Promise<void> => {
            await ports.store.update(record.id, { status });
            await ports.store.addEvent(record.id, ports.now(), status, detail);
        };

        const markFailed = async (record: RequestRecord, message: string): Promise<void> => {
            await setStatus(record, "failed", message);
        };

        const exportHandler = async (context: PrivacyWorkflowContext): Promise<void> => {
            const { requestId } = context.params;
            const record = await context.step.do("load", async () => requireRequest(requestId));
            const runContext = contextFor(record);

            try {
                await context.step.do("start", async () => setStatus(record, transition(record.status, "processing")));

                for (const dataset of config.datasets) {
                    // Each dataset is one step: its rows go to storage, so the step returns nothing large.
                    // eslint-disable-next-line no-await-in-loop -- durable steps run in order by design
                    await context.step.do(`collect:${dataset.id}`, async () => collectPart(runContext, dataset, record));
                }

                const archiveKey = await context.step.do("assemble", async () => assembleExport(runContext, config.datasets, record));

                await context.step.do("ready", async () => {
                    await ports.store.update(record.id, {
                        expiresAt: new Date(ports.now().getTime() + EXPORT_EXPIRY_MS),
                        status: transition("processing", "ready"),
                        storageKey: archiveKey,
                    });
                    await ports.store.addEvent(record.id, ports.now(), "ready", archiveKey);
                });
            } catch (error) {
                await context.step.do("fail", async () => markFailed(record, error instanceof Error ? error.message : String(error)));
            }
        };

        const erasureHandler = async (context: PrivacyWorkflowContext): Promise<void> => {
            const { requestId } = context.params;
            const record = await context.step.do("load", async () => requireRequest(requestId));

            if (record.status === "grace" && record.erasureGraceUntil !== undefined) {
                await context.step.sleepUntil("grace", record.erasureGraceUntil);

                // A subject who cancelled during the grace leaves the request cancelled, so the erasure stops here.
                const current = await context.step.do("recheck", async () => requireRequest(requestId));

                if (current.status !== "grace") {
                    return;
                }
            }

            try {
                await context.step.do("start", async () => setStatus(record, transition(record.status, "processing")));

                for (const dataset of erasureOrder(config.datasets)) {
                    // One drain per dataset, in erasure order. Each drain is idempotent, so a retry resumes it.
                    // eslint-disable-next-line no-await-in-loop -- drains run one after another by design
                    await context.step.do(`erase:${dataset.id}`, async () => eraseDataset(dataset, record.subjectId));
                }

                await context.step.do("verify", async () => {
                    const remaining: Record<string, number> = {};

                    for (const dataset of config.datasets) {
                        // eslint-disable-next-line no-await-in-loop -- one read per dataset, in order
                        Object.assign(remaining, await ports.data.remaining(dataset, record.subjectId));
                    }

                    const verdict = verifyErasure(remaining);

                    await setStatus(record, transition("processing", verdict.complete ? "completed" : "failed"), verdict.leftover.join(","));

                    if (verdict.complete && ports.tombstones !== undefined) {
                        await ports.tombstones.add(tombstoneKeyOf(record.subjectId), ports.now());
                    }
                });
            } catch (error) {
                await context.step.do("fail", async () => markFailed(record, error instanceof Error ? error.message : String(error)));
            }
        };

        return {
            cancelRequest: async ({ requestId }) => cancelRequest(ports.store, { id: requestId, now: ports.now() }),

            coverage: (tables, exclusions = {}) => {
                const allExclusions = { ...config.exclude, ...exclusions };
                const classifications: Record<string, TableClassification | undefined> = {};

                for (const dataset of config.datasets) {
                    for (const table of dataset.tableNames) {
                        classifications[table] = { dataset: dataset.id };
                    }
                }

                for (const [table, reason] of Object.entries(allExclusions)) {
                    classifications[table] = { excluded: reason };
                }

                return checkCoverage(tables, classifications);
            },

            extendRequest: async ({ requestId, reason }) => extendRequest(ports.store, { id: requestId, now: ports.now(), reason }),

            requestErasure: async ({ sessionAgeMs, subjectId }) =>
                openRequest(ports.store, {
                    erasure,
                    id: ports.newId(),
                    now: ports.now(),
                    sessionAgeMs,
                    subjectId,
                    type: "erasure",
                }),

            requestExport: async ({ subjectId }) => openRequest(ports.store, { id: ports.newId(), now: ports.now(), subjectId, type: "export" }),

            restore: async ({ restoredSubjectIds }) => {
                if (ports.tombstones === undefined) {
                    throw new LunoraError("BAD_REQUEST", "restore needs a tombstone store: pass `tombstones` to definePrivacy.");
                }

                const subjects = await subjectsToReerase(restoredSubjectIds, ports.tombstones);

                for (const subjectId of subjects) {
                    // Re-erase each subject's rows in the same order a first erasure uses.
                    for (const dataset of erasureOrder(config.datasets)) {
                        // eslint-disable-next-line no-await-in-loop -- one drain per dataset, in order
                        await eraseDataset(dataset, subjectId);
                    }
                }

                return subjects;
            },

            runErasure: async (requestId) => {
                const record = await requireRequest(requestId);
                const outcome = await runErasure(contextFor(record), config.datasets, record);

                if (outcome.status === "completed" && ports.tombstones !== undefined) {
                    await ports.tombstones.add(tombstoneKeyOf(record.subjectId), ports.now());
                }

                return outcome;
            },

            runExport: async (requestId) => {
                const record = await requireRequest(requestId);

                return runExport(contextFor(record), config.datasets, record);
            },

            admin: {
                open: async () => ports.store.listOpen(),

                retry: async (requestId) => {
                    const record = await requireRequest(requestId);

                    if (record.status !== "failed") {
                        throw new LunoraError("UNPROCESSABLE", `Only a failed request can be retried; this one is "${record.status}".`);
                    }

                    return record.type === "export"
                        ? runExport(contextFor(record), config.datasets, record)
                        : runErasure(contextFor(record), config.datasets, record);
                },
            },

            downloadUrl: async ({ requestId, subjectId }) => {
                const record = await requireRequest(requestId);

                // A request for someone else reads as not found, so a caller cannot probe which ids exist.
                if (record.subjectId !== subjectId || record.type !== "export") {
                    throw new LunoraError("NOT_FOUND", `No export with id ${requestId}.`);
                }

                if (record.status !== "ready" || record.storageKey === undefined) {
                    throw new LunoraError("UNPROCESSABLE", "This export is not ready to download.");
                }

                if (record.expiresAt !== undefined && ports.now().getTime() > record.expiresAt.getTime()) {
                    throw new LunoraError("UNPROCESSABLE", "This export has expired. Request a new one.");
                }

                return ports.files.signedUrl(record.storageKey, DOWNLOAD_TTL_SECONDS);
            },

            tick: async () => {
                const now = ports.now().getTime();
                const open = await ports.store.listOpen();
                const overdue = open.filter((record) => isOverdue(record.receivedAt, record.extendedDueAt !== undefined, record.status, ports.now()));
                const approaching = open.filter((record) => {
                    const due = effectiveDueAt(record.receivedAt, record.extendedDueAt !== undefined).getTime();

                    return due - now <= DEADLINE_WARNING_MS && due >= now;
                });

                return { approaching, overdue };
            },

            workflows: { erasureHandler, exportHandler },
        };
    };

    return (context) => bind(config.ports(context));
};

export { definePrivacy, type ErasureOptions, type Privacy, type PrivacyConfig, type PrivacyFor, type PrivacyPorts, type PrivacyWorkflowContext };
