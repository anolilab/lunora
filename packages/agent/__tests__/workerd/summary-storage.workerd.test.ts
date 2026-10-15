/**
 * Real-workerd coverage for the persisted thread summary: the `agentHistory` read
 * at an incremental checkpoint, at a settings-mismatch rebuild and at a due
 * span-doubling rebuild, plus the `ifInstanceId` ownership guard on
 * `agentPatchThread`, against the component's own functions over a Durable
 * Object's SQLite (see `./test-worker.ts`).
 *
 * Only runs with `LUNORA_WORKERD_TESTS=1`; `pnpm --filter "@lunora/agent" run test`
 * covers the `node` project alone.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface History {
    fallback?: { summary: string; throughSeq: number };
    messages: { seq: number }[];
    summary?: string;
}

const KEY = "thread-1";

/** The compaction settings key the loop derives from `{ keepRecent: 5, maxMessages: 10 }`. */
const CONFIG_KEY = "10:5";

/** A fresh store holding a thread owned by `wf-1` with `count` messages (seq 0..count-1). */
const seeded = async (name: string, count: number) => {
    const stub = env.AGENT_STORE.get(env.AGENT_STORE.idFromName(name));
    const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => JSON.parse(await stub.call(fn, args)) as unknown;

    await call("agentEnsureThread", { agent: "support", instanceId: "wf-1", key: KEY });

    for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- seq is allocated in append order
        await call("agentAppendMessage", { content: `m${String(index)}`, messageKey: `k${String(index)}`, role: "user", threadKey: KEY });
    }

    return {
        history: async (configKey?: string): Promise<History> =>
            (await call("agentHistory", { ...(configKey === undefined ? {} : { configKey }), key: KEY })) as History,
        patch: (patch: Record<string, unknown>) => call("agentPatchThread", { key: KEY, ...patch }),
        takeOver: (instanceId: string) => call("agentEnsureThread", { agent: "support", instanceId, key: KEY, onConcurrentRun: "replace" }),
    };
};

describe("persisted thread summary on real workerd storage", () => {
    it("returns the whole thread, with no summary or fallback, before one is stored", async () => {
        const store = await seeded("none", 5);
        const history = await store.history();

        expect(history.messages).toHaveLength(5);
        expect(history.summary).toBeUndefined();
        expect(history.fallback).toBeUndefined();
    });

    it("reads the stored summary plus only the messages after the cursor at an incremental checkpoint", async () => {
        const store = await seeded("incremental", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryConfig: CONFIG_KEY, summaryRebuiltSeq: 5, summaryThroughSeq: 5 });

        const history = await store.history(CONFIG_KEY);

        expect(history.summary).toBe("brief");
        expect(history.messages.map((message) => message.seq)).toStrictEqual([6, 7, 8, 9]);
        expect(history.fallback).toBeUndefined();
    });

    it("reads the whole thread plus the stored summary and cursor as a fallback when a rebuild is due", async () => {
        const store = await seeded("rebuild", 10);

        // The rebuild anchor sits at 0, so the covered span (5) has already doubled the anchor.
        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryConfig: CONFIG_KEY, summaryRebuiltSeq: 0, summaryThroughSeq: 5 });

        const history = await store.history(CONFIG_KEY);

        expect(history.messages).toHaveLength(10);
        expect(history.summary).toBeUndefined();
        expect(history.fallback).toStrictEqual({ summary: "brief", throughSeq: 5 });
    });

    it("reads the whole thread when the caller's compaction settings differ from the summary's", async () => {
        const store = await seeded("settings", 10);

        // The brief was built under `maxMessages: 5`, the caller now runs `10:5`, so its cursor is not applied.
        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryConfig: "5:2", summaryRebuiltSeq: 5, summaryThroughSeq: 5 });

        const history = await store.history(CONFIG_KEY);

        expect(history.messages).toHaveLength(10);
        expect(history.summary).toBeUndefined();
        expect(history.fallback).toStrictEqual({ summary: "brief", throughSeq: 5 });
    });

    it("keeps reading incrementally until the covered span has doubled since the last rebuild", async () => {
        const store = await seeded("doubling", 15);

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryConfig: CONFIG_KEY, summaryRebuiltSeq: 5, summaryThroughSeq: 6 });

        // 6 < 2*5+1: still incremental.
        const before = await store.history(CONFIG_KEY);

        expect(before.summary).toBe("brief");
        expect(before.messages.map((message) => message.seq)).toStrictEqual([7, 8, 9, 10, 11, 12, 13, 14]);

        // 11 >= 2*5+1: a rebuild is due, so the whole thread comes back for a fresh summary.
        await store.patch({ summaryThroughSeq: 11 });
        const after = await store.history(CONFIG_KEY);

        expect(after.messages).toHaveLength(15);
        expect(after.summary).toBeUndefined();
    });

    it("re-anchors the rebuild interval when asked to, without touching the summary", async () => {
        const store = await seeded("reset", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryConfig: CONFIG_KEY, summaryRebuiltSeq: 0, summaryThroughSeq: 5 });
        // A failed rebuild re-anchors at the stored cursor so the next rebuild waits for another doubling.
        await store.patch({ ifInstanceId: "wf-1", summaryRebuiltSeq: 5 });

        const history = await store.history(CONFIG_KEY);

        expect(history.summary).toBe("brief");
        expect(history.messages).toHaveLength(4);
    });

    it("ignores a patch from a run that no longer owns the thread", async () => {
        const store = await seeded("stale", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "newer", summaryConfig: CONFIG_KEY, summaryRebuiltSeq: 8, summaryThroughSeq: 8 });
        // A replacement run takes the thread; the replaced run then writes its older checkpoint.
        await store.takeOver("wf-2");
        await store.patch({ ifInstanceId: "wf-1", summary: "stale", summaryRebuiltSeq: 2, summaryThroughSeq: 3 });

        const history = await store.history(CONFIG_KEY);

        expect(history.summary).toBe("newer");
        expect(history.messages).toHaveLength(1);
    });
});
