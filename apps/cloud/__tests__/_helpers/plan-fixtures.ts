import { vi } from "vitest";

import type { PlanRecord, PlanStore } from "../../src/plans/plan-store";
import { parseStoredRecord } from "../../src/plans/plan-store";
import type { KvNamespaceLike } from "../../src/plans/plan-store-kv";

/**
 * Fixtures shared by the plan (plan 476) suites. Times are relative to {@link T0}, so a
 * test reads as "verified two hours ago" rather than as a date.
 */

export const HOUR = 3_600_000;
export const T0 = 1_000_000_000_000;

/** A control-plane lookup that cannot be reached. */
export const down = (): Promise<Response> => Promise.reject(new Error("control plane unreachable"));

/** A control-plane lookup that answers `body` with 200. */
export const answer = (body: unknown): Promise<Response> => Promise.resolve(Response.json(body, { status: 200 }));

/** An in-memory store. It holds JSON text exactly as KV does, so reads go through the same parse. `raw` seeds or corrupts a value. */
export const createMemoryPlanStore = (): PlanStore & { raw: Map<string, string> } => {
    const raw = new Map<string, string>();

    return {
        delete: (scriptName) => {
            raw.delete(scriptName);

            return Promise.resolve();
        },
        get: (scriptName) => Promise.resolve(parseStoredRecord(raw.get(scriptName))),
        put: (scriptName, record) => {
            raw.set(scriptName, JSON.stringify(record));

            return Promise.resolve();
        },
        raw,
    };
};

/**
 * A memory store seeded with records (as JSON, the way KV holds them), whose `put`, `delete` and
 * `get` are spies, so a test can assert what the dispatcher or the writer did to it.
 */
export const spiedStore = (
    records: Record<string, PlanRecord> = {},
): PlanStore & { delete: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; raw: Map<string, string> } => {
    const store = createMemoryPlanStore();

    for (const [name, record] of Object.entries(records)) {
        store.raw.set(name, JSON.stringify(record));
    }

    return {
        delete: vi.fn<PlanStore["delete"]>(store.delete),
        get: vi.fn<PlanStore["get"]>(store.get),
        put: vi.fn<PlanStore["put"]>(store.put),
        raw: store.raw,
    };
};

/** A Workers KV namespace held in a map. `values` exposes the raw text, keyed as KV keys it. */
export const fakeKv = (initial: Record<string, string> = {}): KvNamespaceLike & { values: Map<string, string> } => {
    const values = new Map(Object.entries(initial));

    return {
        delete: async (key) => {
            values.delete(key);
        },
        get: async (key) => values.get(key) ?? null,
        put: async (key, value) => {
            values.set(key, value);
        },
        values,
    };
};
