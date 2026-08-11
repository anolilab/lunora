/**
 * `onConcurrentRun: "queue"` — the durable per-thread run queue.
 *
 * Exercises the REAL `agentEnsureThread` / `agentCompleteRun` mutations over an
 * in-memory `ctx.db`, because the properties under test are all about what the
 * mutations do to the tables: FIFO order, an idempotent enqueue under replay, an
 * idempotent handoff under replay, and the bound.
 */
import { describe, expect, it } from "vitest";

import { agentComponent } from "../src/component";
import type { EnsureThreadOutcome } from "../src/types";
import type { FakeRow } from "./loop-harness";
import { fakeDatabase } from "./loop-harness";

const setup = () => {
    const { database, rows } = fakeDatabase();
    const { functions } = agentComponent();
    const context = { auth: { userId: undefined }, db: database };

    return {
        complete: async (arguments_: Record<string, unknown>) =>
            (await functions.agentCompleteRun.handler(context, arguments_ as never)) as { dequeued?: string },
        queue: (): FakeRow[] => rows.get("agent_run_queue") ?? [],
        start: async (instanceId?: string) =>
            (await functions.agentEnsureThread.handler(context, {
                agent: "support",
                key: "thread-1",
                onConcurrentRun: "queue",
                ...(instanceId === undefined ? {} : { instanceId }),
            } as never)) as EnsureThreadOutcome,
        thread: (): FakeRow | undefined => (rows.get("agent_threads") ?? [])[0],
    };
};

describe("onConcurrentRun: queue", () => {
    it("parks runs behind the one in flight and hands the thread over in FIFO order", async () => {
        expect.assertions(7);

        const { complete, queue, start, thread } = setup();

        await expect(start("wf-a")).resolves.toStrictEqual({ outcome: "created" });
        await expect(start("wf-b")).resolves.toStrictEqual({ outcome: "queued", position: 0 });
        await expect(start("wf-c")).resolves.toStrictEqual({ outcome: "queued", position: 1 });
        // A parked run must not take the thread from the one in flight.
        expect(thread()?.["instanceId"]).toBe("wf-a");

        // A finishes: the thread goes to B (not to the terminal status), and B's
        // queue row is consumed in the same mutation that transfers ownership.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({ dequeued: "wf-b" });
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("goes idle once the queue drains", async () => {
        expect.assertions(2);

        const { complete, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        await expect(complete({ instanceId: "wf-b", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "idle" });
    });

    it("is idempotent under replay: a parked run re-enqueues to the same slot", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");
        await start("wf-b");

        // A workflow replay re-runs the bootstrap for real (it is outside step.do).
        await expect(start("wf-b")).resolves.toStrictEqual({ outcome: "queued", position: 0 });
        expect(queue()).toHaveLength(1);
    });

    it("is idempotent under replay: a finished run's completion never dequeues twice", async () => {
        expect.assertions(3);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await start("wf-c");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        // A's completion replays after ownership already moved to B. Dequeuing
        // again here would skip B's turn entirely.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()?.["instanceId"]).toBe("wf-b");
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("hands the thread on even when the finishing run errored", async () => {
        expect.assertions(1);

        const { complete, start } = setup();

        await start("wf-a");
        await start("wf-b");

        // B is waiting for A to END, not to succeed.
        await expect(complete({ error: "boom", instanceId: "wf-a", key: "thread-1", status: "error" })).resolves.toStrictEqual({ dequeued: "wf-b" });
    });

    it("rejects past the depth cap instead of parking unboundedly", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");

        for (const id of ["wf-b", "wf-c", "wf-d", "wf-e", "wf-f"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each enqueue must observe the previous one's row
            await start(id);
        }

        expect(queue()).toHaveLength(5);
        await expect(start("wf-g")).rejects.toThrow("run queue is full");
    });

    it("releases the slot of a run that ends while still parked", async () => {
        expect.assertions(2);

        const { complete, queue, start } = setup();

        await start("wf-a");
        await start("wf-b");
        await start("wf-c");

        // B's 12h wait elapsed (or it threw before its turn): it is not the
        // thread's owner, but it still holds a queue slot. Without releasing it,
        // five abandoned runs exhaust the depth cap and every later start on this
        // thread is refused forever.
        await expect(complete({ instanceId: "wf-b", key: "thread-1", status: "error" })).resolves.toStrictEqual({});
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("keeps a failed run's error visible when it hands the thread on", async () => {
        expect.assertions(1);

        const { complete, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await complete({ error: "model refused", instanceId: "wf-a", key: "thread-1", status: "error" });

        // The thread moves straight to B's run; clearing the error here would
        // erase the only record that A failed at all.
        expect(thread()).toMatchObject({ error: "model refused", instanceId: "wf-b", status: "running" });
    });

    it("reclaims a thread whose owner was terminated while parked", async () => {
        expect.assertions(2);

        const { start, thread } = setup();

        await start("wf-a");
        await start("wf-b");

        // Ownership transfers before the wake is sent, so an instance terminated
        // while parked leaves the thread pointing at a workflow that never
        // resumes. Age the row past the abandonment window.
        Object.assign(thread() ?? {}, { updatedAt: Date.now() - 14 * 60 * 60 * 1000 });

        // A new run takes it rather than CONFLICTing against a corpse forever.
        await expect(start("wf-z")).resolves.toStrictEqual({ outcome: "continued" });
        expect(thread()?.["instanceId"]).toBe("wf-z");
    });

    it("refuses to queue a dispatch that has no instance id to wake", async () => {
        expect.assertions(2);

        const { queue, start } = setup();

        await start("wf-a");

        // The inbound-email / inbound-channel paths dispatch with no instanceId:
        // nothing could tell two such dispatches apart later to wake the right
        // one, so parking them would strand a run rather than order it.
        await expect(start()).rejects.toThrow("cannot queue a dispatch with no instance id");
        expect(queue()).toHaveLength(0);
    });
});
