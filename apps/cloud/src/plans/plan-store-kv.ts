import type { PlanReader, PlanStore } from "./plan-store";
import { parseStoredRecord } from "./plan-store";

/**
 * The slice of a Workers KV namespace the plan store uses. Declared structurally
 * so this file takes no Cloudflare types; a real `KVNamespace` binding satisfies it.
 */
export interface KvNamespaceLike {
    delete: (key: string) => Promise<void>;
    get: (key: string) => Promise<null | string>;
    put: (key: string, value: string) => Promise<void>;
}

/** The key of one script's record: `plan:` followed by the script name. */
export const planKey = (scriptName: string): string => `plan:${scriptName}`;

/**
 * The dispatcher's read side over a KV namespace. It is handed only `get`, so the
 * dispatcher cannot write the store even by accident. A malformed or non-JSON value
 * reads as absent and a KV failure rejects; the resolver refuses on both.
 */
export const createKvPlanReader = (kv: Pick<KvNamespaceLike, "get">): PlanReader => {
    return {
        get: async (scriptName) => parseStoredRecord(await kv.get(planKey(scriptName))),
    };
};

/** The control plane's write side over a KV namespace: `put` and `delete`, plus the same read. */
export const createKvPlanStore = (kv: KvNamespaceLike): PlanStore => {
    return {
        ...createKvPlanReader(kv),
        delete: async (scriptName) => {
            await kv.delete(planKey(scriptName));
        },
        put: async (scriptName, record) => {
            await kv.put(planKey(scriptName), JSON.stringify(record));
        },
    };
};
