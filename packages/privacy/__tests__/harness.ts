/**
 * The shared test harness: in-memory ports that keep the state a test reads back, the `tasks`
 * dataset, a `definePrivacy` wiring over them, and the workflow step runners the tests drive.
 */
import { LunoraError } from "@lunora/errors";

import type { Dataset } from "../src/dataset";
import { defineDataset } from "../src/dataset";
import { DAY_MS } from "../src/deadlines";
import type { ErasureOptions, Privacy, PrivacyIdentity, PrivacyWorkflowContext } from "../src/define";
import { definePrivacy } from "../src/define";
import { isTerminal } from "../src/lifecycle";
import type { ArchivePort, DataPort, StorePort } from "../src/ports";
import type { RequestRecord, RequestStore } from "../src/requests";
import type { PrivacyPreset } from "../src/rules";
import type { TombstonePort } from "../src/tombstones";

export const NOW = new Date("2026-10-11T10:00:00.000Z");

export const SUBJECT: PrivacyIdentity = { sessionAgeMs: 60_000, subjectId: "u1" };

export const SECRET = "test-tombstone-secret";

export const tasksDataset: Dataset = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: { omit: ["activeCycle"] } },
});

export const memoryRequests = (): RequestStore & { events: string[]; rows: Map<string, RequestRecord> } => {
    const rows = new Map<string, RequestRecord>();
    const events: string[] = [];

    return {
        addEvent: async (requestId, _at, kind) => {
            events.push(`${requestId}:${kind}`);
        },
        events,
        findOpen: async (subjectId, type) => [...rows.values()].find((row) => row.subjectId === subjectId && row.type === type && !isTerminal(row.status)),
        get: async (id) => rows.get(id),
        insert: async (record) => {
            rows.set(record.id, record);
        },
        listForSubject: async (subjectId) => [...rows.values()].filter((row) => row.subjectId === subjectId),
        listOpen: async () => [...rows.values()].filter((row) => !isTerminal(row.status)),
        claim: async (id, from, patch) => {
            const existing = rows.get(id);

            // No await between the check and the write, so two claims cannot interleave here.
            if (existing?.status !== from) {
                return false;
            }

            rows.set(id, { ...existing, ...patch });

            return true;
        },
        rows,
        update: async (id, patch) => {
            const existing = rows.get(id);

            if (existing !== undefined) {
                rows.set(id, { ...existing, ...patch });
            }
        },
    };
};

export type MemoryFiles = StorePort & { files: Map<string, Uint8Array | string> };

export const memoryFiles = (): MemoryFiles => {
    const files = new Map<string, Uint8Array | string>();

    return {
        delete: async (key) => {
            files.delete(key);
        },
        files,
        list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
        put: async (requestId, file) => {
            files.set(`${requestId}/${file.name}`, file.data);

            return `${requestId}/${file.name}`;
        },
        read: async (requestId, name) => {
            const value = files.get(`${requestId}/${name}`);

            return typeof value === "string" ? value : undefined;
        },
        signedUrl: async (key, ttlSeconds) => `https://files.test/${key}?ttl=${String(ttlSeconds)}`,
    };
};

/**
 * A data port over per-table row counts. Each erase batch clears up to 100 rows
 * from every table, as a real port would, and `remaining` reports what is left.
 */
/** The key of a file an export run wrote, which sits under the request id and then the run id. */
export const exportFileOf = (files: MemoryFiles, requestId: string, name: string): string =>
    [...files.files.keys()].find((key) => key.startsWith(`${requestId}/`) && key.endsWith(`/${name}`)) ?? `${requestId}/<no ${name}>`;

export const memoryData = (initial: Readonly<Record<string, number>> = {}): DataPort & { rows: Record<string, number> } => {
    const rows: Record<string, number> = { ...initial };

    return {
        collect: async (dataset: Dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, [{ id: `${table}-1` }]])),
        eraseBatch: async (dataset: Dataset) => {
            let hasMore = false;

            for (const table of dataset.tableNames) {
                rows[table] = Math.max(0, (rows[table] ?? 0) - 100);
                hasMore = hasMore || (rows[table] ?? 0) > 0;
            }

            return { hasMore };
        },
        remaining: async (dataset: Dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, rows[table] ?? 0])),
        rows,
    };
};

/** Tombstones in a map. `add` overwrites, so it is the idempotent upsert the port contract asks for. */
export const memoryTombstones = (): TombstonePort & { stored: Map<string, Date> } => {
    const stored = new Map<string, Date>();

    return {
        add: async (key, erasedAt) => {
            stored.set(key, erasedAt);
        },
        has: async (key) => stored.has(key),
        keys: async () => new Set(stored.keys()),
        stored,
    };
};

/** The error code a promise rejects with, `"not-lunora"` for any other error, or `"no-error"`. */
export const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

/** A value after a JSON round trip. `structuredClone` would keep a `Date`, which is the point. */
export const throughJson = (value: unknown): unknown => {
    const text = JSON.stringify(value) as string | undefined;

    return text === undefined ? undefined : JSON.parse(text);
};

/**
 * A step runner that behaves like a durable host: each named step's result is stored as JSON, so a
 * replay hands back the parsed copy instead of running the step again, and a step that throws is
 * retried, as the host's step retry does. `names` lists every step and sleep in the order they were
 * asked for. `failOnce` makes the named step throw on its first run; `onSleep` runs during the grace
 * sleep, so a test can change the request while the workflow waits.
 */
export const durableStep = (
    options: { failOnce?: string; onSleep?: () => void } = {},
): { names: string[]; runs: Map<string, number>; sleeps: Date[]; step: PrivacyWorkflowContext["step"] } => {
    const results = new Map<string, unknown>();
    const runs = new Map<string, number>();
    const names: string[] = [];
    const sleeps: Date[] = [];
    let { failOnce } = options;

    const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
        runs.set(name, (runs.get(name) ?? 0) + 1);

        if (name === failOnce) {
            failOnce = undefined;

            throw new Error(`step ${name} crashed`);
        }

        return run();
    };

    return {
        names,
        runs,
        sleeps,
        step: {
            do: async <T>(name: string, run: () => Promise<T>): Promise<T> => {
                names.push(name);

                if (!results.has(name)) {
                    let value: T;

                    try {
                        value = await attempt(name, run);
                    } catch {
                        value = await attempt(name, run);
                    }

                    results.set(name, throughJson(value));
                }

                return results.get(name) as T;
            },
            sleepUntil: async (name, when) => {
                names.push(`sleep:${name}`);
                sleeps.push(when);
                options.onSleep?.();
            },
        },
    };
};

export interface HarnessOptions {
    readonly archive?: ArchivePort;
    readonly data?: DataPort;
    readonly datasets?: ReadonlyArray<Dataset>;
    readonly erasure?: ErasureOptions;
    readonly files?: MemoryFiles;
    readonly now?: Date;
    readonly presets?: ReadonlyArray<PrivacyPreset>;
    /** Initial row counts for the default in-memory data port. */
    readonly rows?: Readonly<Record<string, number>>;
    readonly store?: ReturnType<typeof memoryRequests>;
    /** `null` leaves the tombstone store out of the ports. */
    readonly tombstones?: TombstonePort | null;
    /** `null` leaves the secret out of the config, as an app that never set it would. */
    readonly tombstoneSecret?: string | null;
}

export interface Harness {
    readonly advance: (days: number) => void;
    readonly as: (identity: PrivacyIdentity) => Privacy;
    readonly files: MemoryFiles;
    readonly operator: Privacy;
    readonly privacy: Privacy;
    readonly rows: Record<string, number>;
    readonly runErasureWorkflow: (requestId: string, step?: PrivacyWorkflowContext["step"]) => Promise<void>;
    readonly runExportWorkflow: (requestId: string, step?: PrivacyWorkflowContext["step"]) => Promise<void>;
    readonly setClock: (at: Date) => void;
    readonly store: ReturnType<typeof memoryRequests>;
    readonly tombstones: TombstonePort | null;
}

/**
 * `definePrivacy` over the in-memory ports. `privacy` is bound to {@link SUBJECT}; `as` binds another
 * subject over the same ports, and `operator` binds no subject, as a cron or an admin call would.
 */
export const setup = (options: HarnessOptions = {}): Harness => {
    const memory = memoryData(options.rows ?? { goals: 0, tasks: 0 });
    const data = options.data ?? memory;
    const files = options.files ?? memoryFiles();
    const store = options.store ?? memoryRequests();
    const tombstones = options.tombstones === undefined ? memoryTombstones() : options.tombstones;
    const tombstoneSecret = options.tombstoneSecret === undefined ? SECRET : options.tombstoneSecret;
    let clock = options.now ?? NOW;
    let counter = 0;

    const privacyFor = definePrivacy({
        datasets: options.datasets ?? [tasksDataset],
        ports: () => {
            return {
                data,
                files,
                newId: () => {
                    counter += 1;

                    return `r${String(counter)}`;
                },
                now: () => clock,
                store,
                ...(options.archive === undefined ? {} : { archive: options.archive }),
                ...(tombstones === null ? {} : { tombstones }),
            };
        },
        ...(options.erasure === undefined ? {} : { erasure: options.erasure }),
        ...(options.presets === undefined ? {} : { presets: options.presets }),
        ...(tombstoneSecret === null ? {} : { tombstoneSecret }),
    });

    return {
        advance: (days) => {
            clock = new Date(clock.getTime() + days * DAY_MS);
        },
        as: (identity) => privacyFor(undefined, identity),
        files,
        operator: privacyFor(undefined),
        privacy: privacyFor(undefined, SUBJECT),
        rows: memory.rows,
        /** Run the erasure workflow to its end. The grace sleep returns at once. */
        runErasureWorkflow: async (requestId, step = durableStep().step) => privacyFor(undefined).workflows.erasureHandler({ params: { requestId }, step }),
        /** Run the export workflow to its end. */
        runExportWorkflow: async (requestId, step = durableStep().step) => privacyFor(undefined).workflows.exportHandler({ params: { requestId }, step }),
        setClock: (at) => {
            clock = at;
        },
        store,
        tombstones,
    };
};

export { DAY_MS } from "../src/deadlines";
