/**
 * Real-workerd coverage for the persisted thread summary: the `agentHistory` read
 * at an incremental and at a rebuild checkpoint, and the `ifInstanceId` ownership
 * guard on `agentPatchThread`, against the component's own functions over a
 * Durable Object's SQLite (see `./test-worker.ts`).
 *
 * Only runs with `LUNORA_WORKERD_TESTS=1`; `pnpm --filter "@lunora/agent" run test`
 * covers the `node` project alone.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface History {
    fallback?: { summary: string; throughSeq: number };
    messages: { seq: number }[];
    runs: number;
    summary?: string;
}

const KEY = "thread-1";

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
        history: async (): Promise<History> => (await call("agentHistory", { key: KEY })) as History,
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

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryRuns: 3, summaryThroughSeq: 5 });

        const history = await store.history();

        expect(history.summary).toBe("brief");
        expect(history.runs).toBe(3);
        expect(history.messages.map((message) => message.seq)).toStrictEqual([6, 7, 8, 9]);
        expect(history.fallback).toBeUndefined();
    });

    it("reads the whole thread plus the stored summary and cursor as a fallback at a rebuild checkpoint", async () => {
        const store = await seeded("rebuild", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryRuns: 10, summaryThroughSeq: 5 });

        const history = await store.history();

        expect(history.messages).toHaveLength(10);
        expect(history.summary).toBeUndefined();
        expect(history.runs).toBe(0);
        expect(history.fallback).toStrictEqual({ summary: "brief", throughSeq: 5 });
    });

    it("resets only the run counter, leaving the summary and cursor, when asked to", async () => {
        const store = await seeded("reset", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "brief", summaryRuns: 10, summaryThroughSeq: 5 });
        await store.patch({ ifInstanceId: "wf-1", summaryRuns: 0 });

        const history = await store.history();

        expect(history.summary).toBe("brief");
        expect(history.runs).toBe(0);
        expect(history.messages).toHaveLength(4);
    });

    it("ignores a patch from a run that no longer owns the thread", async () => {
        const store = await seeded("stale", 10);

        await store.patch({ ifInstanceId: "wf-1", summary: "newer", summaryRuns: 1, summaryThroughSeq: 8 });
        // A replacement run takes the thread; the replaced run then writes its older checkpoint.
        await store.takeOver("wf-2");
        await store.patch({ ifInstanceId: "wf-1", summary: "stale", summaryRuns: 2, summaryThroughSeq: 3 });

        const history = await store.history();

        expect(history.summary).toBe("newer");
        expect(history.runs).toBe(1);
        expect(history.messages).toHaveLength(1);
    });
});
