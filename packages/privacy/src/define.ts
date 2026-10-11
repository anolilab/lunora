/**
 * `definePrivacy`: binds an app's datasets, presets and ports into one object the
 * app's mutations and workflows call. Each method is a thin wrapper over the
 * tested service and run functions, so the Cloudflare layer only supplies ports.
 */
import { LunoraError } from "@lunora/errors";

import type {CoverageProblem, TableClassification} from "./coverage";
import { checkCoverage } from "./coverage";
import type { Dataset } from "./dataset";
import type {RequestRecord, RequestStore} from "./requests";
import { cancelRequest, extendRequest, openRequest } from "./requests";
import type { PrivacyPreset, RetentionRule } from "./rules";
import type {DataPort, ErasureOutcome, ExportOutcome, StorePort} from "./run";
import { runErasure, runExport } from "./run";

/** The app's erasure settings. The defaults are the decided values (D3 and the sign-in window). */
interface ErasureOptions {
    readonly drainBudgetDays?: number;
    readonly freshAgeMs?: number;
    readonly graceDays?: number;
}

/** Everything `definePrivacy` needs from the app. */
interface PrivacyConfig {
    readonly data: DataPort;
    readonly datasets: ReadonlyArray<Dataset>;
    readonly erasure?: ErasureOptions;
    readonly files: StorePort;
    readonly newId: () => string;
    readonly now: () => Date;
    readonly presets?: ReadonlyArray<PrivacyPreset>;
    readonly store: RequestStore;
    /** The identifier the archive shows for the subject. Defaults to the subject id itself. */
    readonly subjectKey?: (subjectId: string) => string;
}

/** The bound API. */
interface Privacy {
    readonly cancelRequest: (input: { requestId: string }) => Promise<RequestRecord>;
    readonly coverage: (tables: ReadonlyArray<string>, exclusions?: Readonly<Record<string, string>>) => ReadonlyArray<CoverageProblem>;
    readonly extendRequest: (input: { reason: string; requestId: string; }) => Promise<RequestRecord>;
    readonly requestErasure: (input: { sessionAgeMs: number; subjectId: string; }) => Promise<RequestRecord>;
    readonly requestExport: (input: { subjectId: string }) => Promise<RequestRecord>;
    readonly runErasure: (requestId: string) => Promise<ErasureOutcome>;
    readonly runExport: (requestId: string) => Promise<ExportOutcome>;
}

const DEFAULT_GRACE_DAYS = 14;
const DEFAULT_DRAIN_BUDGET_DAYS = 3;
const DEFAULT_FRESH_AGE_MS = 24 * 60 * 60 * 1000;

/** Bind the config into the API. Pure construction: nothing runs until a method is called. */
const definePrivacy = (config: PrivacyConfig): Privacy => {
    const rules = new Map<string, RetentionRule>();

    for (const preset of config.presets ?? []) {
        for (const rule of preset.retention) {
            rules.set(rule.id, rule);
        }
    }

    const erasure = {
        drainBudgetDays: config.erasure?.drainBudgetDays ?? DEFAULT_DRAIN_BUDGET_DAYS,
        freshAgeMs: config.erasure?.freshAgeMs ?? DEFAULT_FRESH_AGE_MS,
        graceDays: config.erasure?.graceDays ?? DEFAULT_GRACE_DAYS,
    };
    const subjectKey = config.subjectKey ?? ((subjectId: string) => subjectId);
    const context = {
        data: config.data,
        files: config.files,
        now: config.now,
        rules,
        store: config.store,
    };

    const requireRequest = async (requestId: string): Promise<RequestRecord> => {
        const record = await config.store.get(requestId);

        if (record === undefined) {
            throw new LunoraError("NOT_FOUND", `No privacy request with id ${requestId}.`);
        }

        return record;
    };

    return {
        cancelRequest: async ({ requestId }) => cancelRequest(config.store, { id: requestId, now: config.now() }),

        coverage: (tables, exclusions = {}) => {
            const classifications: Record<string, TableClassification | undefined> = {};

            for (const dataset of config.datasets) {
                for (const table of dataset.tableNames) {
                    classifications[table] = { dataset: dataset.id };
                }
            }

            for (const [table, reason] of Object.entries(exclusions)) {
                classifications[table] = { excluded: reason };
            }

            return checkCoverage(tables, classifications);
        },

        extendRequest: async ({ requestId, reason }) => extendRequest(config.store, { id: requestId, now: config.now(), reason }),

        requestErasure: async ({ sessionAgeMs, subjectId }) =>
            openRequest(config.store, {
                erasure,
                id: config.newId(),
                now: config.now(),
                sessionAgeMs,
                subjectId,
                type: "erasure",
            }),

        requestExport: async ({ subjectId }) => openRequest(config.store, { id: config.newId(), now: config.now(), subjectId, type: "export" }),

        runErasure: async (requestId) => {
            const record = await requireRequest(requestId);

            return runErasure({ ...context, subjectKey: subjectKey(record.subjectId) }, config.datasets, record);
        },

        runExport: async (requestId) => {
            const record = await requireRequest(requestId);

            return runExport({ ...context, subjectKey: subjectKey(record.subjectId) }, config.datasets, record);
        },
    };
};

export { definePrivacy, type ErasureOptions, type Privacy, type PrivacyConfig };
