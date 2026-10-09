/**
 * The hourly GraphQL families of a readback fleet — storage (`d1`,
 * `durableObjects`) and compute (`workersCpu`, `durableObjectRequests`,
 * `durableObjectDuration`) — over the per-account readers in
 * `src/cloudflare/storage-usage.ts` and `src/cloudflare/compute-usage.ts`. Shared by
 * `cloudflare-wfp` (the cell's account) and `cloudflare-workers` (each
 * connected account): the readers answer usage per tenant NAME (an alias, or
 * a script name), and each target turns a name into its own `resourceRef`.
 */
import type { PeriodUsage } from "../billing/spend";
import type { UsageReadback, UsageRow, UsageSource, UsageWindow } from "./driver";

/** Storage row counts per tenant in a closed window — `src/cloudflare/storage-usage.ts` over one account. */
export interface StorageReaders {
    /** D1 rows per alias. */
    d1: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>;
    /** Durable Object duration (GB-s) per script; absent → not metered here. */
    durableObjectDuration?: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>;
    /** Durable Object requests per script; absent → not metered here. */
    durableObjectRequests?: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>;
    /** Durable Object rows per script (the alias, on `cloudflare-wfp`). */
    durableObjects: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>;
    /** Workers CPU time (ms) per script; absent → not metered here. */
    workersCpu?: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>;
}

/** The families {@link storageSources} builds. */
export type AccountFamily = "d1" | "durableObjectDuration" | "durableObjectRequests" | "durableObjects" | "workersCpu";

/** Rows of a `{ name → usage }` map, each resource named by `resourceRef`. */
export const usageRows = (byName: ReadonlyMap<string, PeriodUsage>, resourceRef: (name: string) => string): UsageRow[] =>
    [...byName].map(([name, meters]) => {
        return { meters, resourceRef: resourceRef(name) };
    });

/** The hourly families of one account's readers, read only for `scope`. A reader that is absent has no family. */
export const storageSources = (
    storage: StorageReaders,
    options: { resourceRef: (name: string) => string; serves: (scope: string) => Promise<boolean> | boolean },
): Pick<UsageReadback["sources"], AccountFamily> => {
    const source = (read: (window: UsageWindow) => Promise<Map<string, PeriodUsage>>): UsageSource => {
        return {
            cadence: "hourly",
            read: async (scope, window) => ((await options.serves(scope)) ? usageRows(await read(window), options.resourceRef) : []),
        };
    };
    const { durableObjectDuration, durableObjectRequests, workersCpu } = storage;

    return {
        d1: source(storage.d1),
        durableObjects: source(storage.durableObjects),
        ...(workersCpu === undefined ? {} : { workersCpu: source(workersCpu) }),
        ...(durableObjectRequests === undefined ? {} : { durableObjectRequests: source(durableObjectRequests) }),
        ...(durableObjectDuration === undefined ? {} : { durableObjectDuration: source(durableObjectDuration) }),
    };
};
