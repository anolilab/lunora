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
import { dispositionFor, drainUntilEmpty } from "./erasure";
import { checkErasureGraceDays, DEFAULT_ERASURE_GRACE_DAYS } from "./eu";
import type { RequestStatus } from "./lifecycle";
import { effectiveDueAt, isOverdue, isTerminal, transition } from "./lifecycle";
import type { RequestRecord, RequestStore } from "./requests";
import { cancelRequest, extendRequest, fromStepRecord, openRequest, toStepRecord } from "./requests";
import type { PrivacyPreset, RetentionRule } from "./rules";
import type { DataPort, ErasureOutcome, ExportOutcome, RunContext, StorePort } from "./run";
import { assembleExport, collectPart, eraseSubjectFiles, expireRequestFiles, EXPORT_EXPIRY_MS, runErasure, runExport, verifySubjectErased } from "./run";
import type { TombstonePort } from "./tombstones";
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

/** The app's erasure settings. The defaults are the decided values (D3 and the sign-in window). */
interface ErasureOptions {
    readonly drainBudgetDays?: number;
    readonly freshAgeMs?: number;
    readonly graceDays?: number;
}

/**
 * The authenticated subject of an invocation. The app binds it from its session, never from a
 * request argument, so a caller cannot act on another subject's data by naming them.
 */
interface PrivacyIdentity {
    readonly sessionAgeMs: number;
    readonly subjectId: string;
}

/** The ports one invocation binds: the app's data, storage, requests, clock and authenticated subject. */
interface PrivacyPorts {
    readonly data: DataPort;
    readonly files: StorePort;
    /** The authenticated subject. Throws when the invocation has none (a workflow step, a cron). */
    readonly identity: () => PrivacyIdentity;
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

    /**
     * The HMAC secret tombstone keys are derived with. Required once the ports pass `tombstones`:
     * an erasure and `restore` refuse to run without it. Keep it in a secret binding, and keep it
     * stable, because a new secret no longer matches the tombstones already written.
     */
    readonly tombstoneSecret?: string;
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
    readonly extendRequest: (input: { reason: string; requestId: string }) => Promise<RequestRecord>;
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
    const disposition = dispositionFor(rules);

    const bind = (ports: PrivacyPorts): Privacy => {
        const base = { data: ports.data, files: ports.files, now: ports.now, rules, store: ports.store };

        const eraseDataset = async (dataset: Dataset, subjectId: string): Promise<void> => {
            await drainUntilEmpty(() => ports.data.eraseBatch(dataset, subjectId, ports.now(), disposition));
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

        // The app's `listOpen` is filtered again, so a terminal request never reaches a sweep or a report.
        const listOpen = async (): Promise<ReadonlyArray<RequestRecord>> => {
            const listed = await ports.store.listOpen();

            return listed.filter((record) => !isTerminal(record.status));
        };

        const setStatus = async (record: RequestRecord, status: RequestStatus, detail?: string): Promise<void> => {
            await ports.store.update(record.id, { status });
            await ports.store.addEvent(record.id, ports.now(), status, detail);
        };

        // A failure never overwrites a request that is already terminal (cancelled or completed).
        const markFailed = async (record: RequestRecord, message: string): Promise<void> => {
            const current = await requireRequest(record.id);

            if (!isTerminal(current.status)) {
                await setStatus(record, "failed", message);
            }
        };

        // The run starts from the status it finds now, so a cancel that lands during the load step is respected.
        const startRun = async (record: RequestRecord): Promise<void> => {
            const current = await requireRequest(record.id);

            await setStatus(record, transition(current.status, "processing"));
        };

        // Checked before anything is erased, so a missing secret never leaves an erasure completed without its tombstone.
        const requireTombstoneSecret = (): string => {
            if (config.tombstoneSecret === undefined || config.tombstoneSecret === "") {
                throw new LunoraError("BAD_REQUEST", "Tombstones need a secret: pass `tombstoneSecret` to definePrivacy.");
            }

            return config.tombstoneSecret;
        };

        // One erasure path for the workflow, the public entry and the operator retry: the tombstone is
        // written in every case, so a restored backup is erased again whichever path ran it.
        const eraseAndTombstone = async (record: RequestRecord): Promise<ErasureOutcome> => {
            const secret = ports.tombstones === undefined ? undefined : requireTombstoneSecret();
            const outcome = await runErasure(contextFor(record), config.datasets, record);

            if (outcome.status === "completed" && ports.tombstones !== undefined && secret !== undefined) {
                await ports.tombstones.add(tombstoneKeyOf(record.subjectId, secret), ports.now());
            }

            return outcome;
        };

        const exportHandler = async (context: PrivacyWorkflowContext): Promise<void> => {
            const { requestId } = context.params;
            // Step results are stored as JSON, so the record crosses the step as ISO strings and is rehydrated here.
            const record = fromStepRecord(await context.step.do("load", async () => toStepRecord(await requireRequest(requestId))));
            const runContext = contextFor(record);

            try {
                await context.step.do("start", async () => startRun(record));

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
            const record = fromStepRecord(await context.step.do("load", async () => toStepRecord(await requireRequest(requestId))));

            if (record.status === "grace" && record.erasureGraceUntil !== undefined) {
                await context.step.sleepUntil("grace", record.erasureGraceUntil);

                // A subject who cancelled during the grace leaves the request cancelled, so the erasure stops here.
                const status = await context.step.do("recheck", async () => {
                    const current = await requireRequest(requestId);

                    return current.status;
                });

                if (status !== "grace") {
                    return;
                }
            }

            try {
                const secret = ports.tombstones === undefined ? undefined : requireTombstoneSecret();

                await context.step.do("start", async () => startRun(record));

                for (const dataset of erasureOrder(config.datasets)) {
                    // One drain per dataset, in erasure order. Each drain is idempotent, so a retry resumes it.
                    // eslint-disable-next-line no-await-in-loop -- drains run one after another by design
                    await context.step.do(`erase:${dataset.id}`, async () => eraseDataset(dataset, record.subjectId));
                }

                await context.step.do("erase:files", async () => eraseSubjectFiles(ports, config.datasets, record.subjectId));

                await context.step.do("verify", async () => {
                    const verdict = await verifySubjectErased(base, config.datasets, record.subjectId);

                    await setStatus(record, transition("processing", verdict.complete ? "completed" : "failed"), verdict.leftover.join(","));

                    if (verdict.complete && ports.tombstones !== undefined && secret !== undefined) {
                        await ports.tombstones.add(tombstoneKeyOf(record.subjectId, secret), ports.now());
                    }
                });
            } catch (error) {
                await context.step.do("fail", async () => markFailed(record, error instanceof Error ? error.message : String(error)));
            }
        };

        return {
            cancelRequest: async ({ requestId }) => {
                await requireOwnedRequest(ports.store, requestId, ports.identity().subjectId);

                return cancelRequest(ports.store, { id: requestId, now: ports.now() });
            },

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

            extendRequest: async ({ reason, requestId }) => {
                await requireOwnedRequest(ports.store, requestId, ports.identity().subjectId);

                return extendRequest(ports.store, { id: requestId, now: ports.now(), reason });
            },

            requestErasure: async () => {
                const { sessionAgeMs, subjectId } = ports.identity();

                return openRequest(ports.store, { erasure, id: ports.newId(), now: ports.now(), sessionAgeMs, subjectId, type: "erasure" });
            },
            requestExport: async () => openRequest(ports.store, { id: ports.newId(), now: ports.now(), subjectId: ports.identity().subjectId, type: "export" }),

            myRequests: async () => {
                const { subjectId } = ports.identity();

                const open = await listOpen();

                return open.filter((record) => record.subjectId === subjectId);
            },

            restore: async ({ restoredSubjectIds }) => {
                if (ports.tombstones === undefined) {
                    throw new LunoraError("BAD_REQUEST", "restore needs a tombstone store: pass `tombstones` to definePrivacy.");
                }

                const subjects = await subjectsToReerase(restoredSubjectIds, ports.tombstones, requireTombstoneSecret());

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

                // The grace window is the subject's cancellation period. The erasure workflow waits it out; this entry must not skip it.
                if (record.status === "grace") {
                    throw new LunoraError("UNPROCESSABLE", "This erasure is inside its grace window. The erasure workflow runs it when the window ends.");
                }

                return eraseAndTombstone(record);
            },

            runExport: async (requestId) => {
                const record = await requireRequest(requestId);

                return runExport(contextFor(record), config.datasets, record);
            },

            admin: {
                open: listOpen,

                retry: async (requestId) => {
                    const record = await requireRequest(requestId);

                    if (record.status !== "failed") {
                        throw new LunoraError("UNPROCESSABLE", `Only a failed request can be retried; this one is "${record.status}".`);
                    }

                    return record.type === "export" ? runExport(contextFor(record), config.datasets, record) : eraseAndTombstone(record);
                },

                sweep: async () => {
                    const now = ports.now().getTime();
                    const open = await listOpen();
                    const due = open.filter((record) => record.status === "ready" && record.expiresAt !== undefined && record.expiresAt.getTime() < now);

                    await Promise.all(due.map(async (record) => expireRequestFiles(base, record)));

                    return due.map((record) => {
                        return { ...record, status: "expired" as const };
                    });
                },
            },

            downloadUrl: async ({ requestId }) => {
                const { subjectId } = ports.identity();
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
                const open = await listOpen();
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
