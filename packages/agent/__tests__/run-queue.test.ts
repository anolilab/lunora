/**
 * `onConcurrentRun: "queue"` — the durable per-thread run queue.
 *
 * Exercises the REAL `agentEnsureThread` / `agentCompleteRun` mutations over an
 * in-memory `ctx.db`, because the properties under test are all about what the
 * mutations do to the tables: FIFO order, an idempotent enqueue under replay, an
 * idempotent handoff under replay, and the bound.
 */
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { agentComponent } from "../src/component";
import { defineAgent } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentFunctionReference, AgentRunFunction, EnsureThreadOutcome } from "../src/types";
import type { FakeRow } from "./loop-harness";
import { DurableStepJournal, fakeDatabase, finalTurn, scriptedGenerate } from "./loop-harness";

const setup = () => {
    const { database, rows } = fakeDatabase();
    const { functions } = agentComponent();
    const context = { auth: { userId: undefined }, db: database };

    // The loop's `agents:*` refs against the REAL mutations over the same db, so
    // a loop-level test observes the very rows the mutation tests assert on.
    const run: AgentRunFunction = async (reference: AgentFunctionReference, arguments_?: Record<string, unknown>) => {
        const handlers: Record<string, { handler: (context_: unknown, args: never) => unknown } | undefined> = {
            [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage]: functions.agentAppendMessage,
            [DEFAULT_AGENT_FUNCTION_PATHS.completeRun]: functions.agentCompleteRun,
            [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread]: functions.agentEnsureThread,
            [DEFAULT_AGENT_FUNCTION_PATHS.listMessages]: functions.agentMessages,
            [DEFAULT_AGENT_FUNCTION_PATHS.patchThread]: functions.agentPatchThread,
        };
        const entry = handlers[reference["__lunoraRef"]];

        if (!entry) {
            throw new Error(`unexpected dispatch: ${reference["__lunoraRef"]}`);
        }

        return entry.handler(context, (arguments_ ?? {}) as never);
    };

    return {
        complete: async (arguments_: Record<string, unknown>) =>
            (await functions.agentCompleteRun.handler(context, arguments_ as never)) as { dequeued?: string },
        queue: (): FakeRow[] => rows.get("agent_run_queue") ?? [],
        run,
        start: async (instanceId?: string, policy: "queue" | "reject" | "replace" = "queue") =>
            (await functions.agentEnsureThread.handler(context, {
                agent: "support",
                key: "thread-1",
                onConcurrentRun: policy,
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

    it("is idempotent under replay: a finished run's completion advances the queue once", async () => {
        expect.assertions(3);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await start("wf-c");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        // A's completion replays after ownership already moved to B. It reports
        // the SAME successor — the wake is a second trip that a lost reply never
        // made, and nothing else will send it — but consumes no further slot:
        // taking wf-c here would skip wf-b's turn entirely.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({ dequeued: "wf-b" });
        expect(thread()?.["instanceId"]).toBe("wf-b");
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("lets a run that already handed the thread on replay without being read as a second run", async () => {
        expect.assertions(5);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await start("wf-c");

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({ dequeued: "wf-b" });

        // The reply was lost, so wf-a's body replays from the top — and the
        // bootstrap is outside `step.do`, so it re-runs for real. wf-a is now
        // neither the owner nor queued: under "queue" it would park behind the
        // successor it just dequeued (and its terminal dispatch with it), under
        // "reject" the replay would fail outright.
        await expect(start("wf-a")).resolves.toStrictEqual({ outcome: "completed" });
        await expect(start("wf-a", "reject")).resolves.toStrictEqual({ outcome: "completed" });

        // It takes nothing: the thread stays with wf-b, and wf-c keeps its slot.
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-c"]);
    });

    it("re-reports nothing once the thread is no longer live", async () => {
        expect.assertions(2);

        const { complete, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({ dequeued: "wf-b" });

        // `cancel()` terminated the successor and patched the thread. wf-a's
        // replay has nothing left to wake: the run it handed to is gone, and a
        // cancelled thread is not waiting on anyone's handoff.
        Object.assign(thread() ?? {}, { status: "cancelled" });

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
    });

    it("stops re-reporting a successor once that successor has run for itself", async () => {
        expect.assertions(4);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await start("wf-b");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        // wf-b woke and replayed its own bootstrap: it is the live owner now,
        // and taking ownership retires wf-a's completion marker. A very late
        // replay of wf-a must not report it again — the run it would wake is
        // running, not parked.
        await expect(start("wf-b")).resolves.toStrictEqual({ outcome: "continued" });

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
        expect(queue()).toHaveLength(0);
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

    it("admits nothing behind a run that already completed — the empty-queue branch's invariant", async () => {
        expect.assertions(4);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");
        await complete({ instanceId: "wf-a", key: "thread-1", status: "idle" });

        // The empty-queue branch leaves `instanceId` naming wf-a, so wf-a's
        // re-dispatched completion is STILL the owner and re-reads the queue.
        // That it finds nothing is a property of the branch, not luck: parking
        // requires a live status under a different instance, and the terminal
        // status just written is not one — wf-b takes the thread outright and
        // stamps its own id, which is what retires wf-a's ownership.
        await expect(start("wf-b")).resolves.toStrictEqual({ outcome: "continued" });
        expect(queue()).toHaveLength(0);

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
    });

    it("never wakes a run parked behind a thread a NON-OWNING writer revived", async () => {
        expect.assertions(6);

        const { complete, queue, start, thread } = setup();

        await start("wf-a");

        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});

        // A voice turn (`voice-turn.ts` calls `agentEnsureThread` with NO
        // `instanceId`, then patches the thread `"running"`). It marks the thread
        // live and takes no ownership, so `instanceId` still names wf-a — which
        // finished.
        await expect(start()).resolves.toStrictEqual({ outcome: "continued" });
        expect(thread()).toMatchObject({ instanceId: "wf-a", status: "running" });

        // A durable run parks behind the voice turn.
        await expect(start("wf-b")).resolves.toStrictEqual({ outcome: "queued", position: 0 });

        // wf-a's completion re-dispatches — at-least-once, and its reply was lost.
        // It STILL passes the ownership check, and without the completion marker
        // it would re-read the queue and hand the thread to wf-b, which is waiting
        // for the voice turn to end. Two writers on one `seq` counter is exactly
        // what the queue exists to prevent, so the re-dispatch re-applies its
        // terminal status and dequeues nobody. wf-b waits for the thread's actual
        // holder, bounded by its own DEQUEUE_TIMEOUT.
        await expect(complete({ instanceId: "wf-a", key: "thread-1", status: "idle" })).resolves.toStrictEqual({});
        expect(queue().map((row) => row["instanceId"])).toStrictEqual(["wf-b"]);
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

/**
 * The loop over those mutations, at the one boundary the mutation tests cannot
 * reach: a run whose handoff COMMITTED and whose reply was lost. Everything the
 * loop holds in memory is gone by the next activation, so what the replay does
 * is decided entirely by what the previous one wrote down.
 */
describe("agent loop — a handoff whose reply was lost", () => {
    it("replays past its own bootstrap and delivers the wake the first activation never sent", async () => {
        expect.assertions(5);

        const { run, start, thread } = setup();
        const woken: { id: string; type: string }[] = [];
        const binding = {
            get: async (id: string) => {
                return {
                    sendEvent: async (event: { payload: unknown; type: string }) => {
                        woken.push({ id, type: event.type });
                    },
                };
            },
        };

        // wf-a is in flight with wf-b parked behind it.
        await start("wf-a");
        await start("wf-b");

        let loseReply = true;
        const lossyRun: AgentRunFunction = async (reference, arguments_) => {
            const result = await run(reference, arguments_);

            // The shard COMMITS the completion and the reply never arrives — a
            // dispatch timeout is a retryable 503 even when the mutation landed.
            if (loseReply && reference["__lunoraRef"] === DEFAULT_AGENT_FUNCTION_PATHS.completeRun) {
                loseReply = false;

                throw new Error("503 dispatch timeout");
            }

            return result;
        };

        const options = {
            agent: defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
            env: { AGENT_SUPPORT: binding },
            exportName: "support",
            // One scripted turn for BOTH activations: a replay that re-ran the
            // model instead of reading the journal exhausts it and throws.
            generate: scriptedGenerate([finalTurn("done")]),
            instanceId: "wf-a",
            params: { input: "hello", threadKey: "thread-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run: lossyRun,
            step: new DurableStepJournal(),
        };

        await expect(runAgentLoop(options)).rejects.toThrow("503 dispatch timeout");

        // Ownership moved in the mutation that committed; the wake is a separate
        // trip the throw cut short, and nothing else sends it.
        expect(thread()).toMatchObject({ instanceId: "wf-b", status: "running" });
        expect(woken).toStrictEqual([]);

        // The next activation of the SAME instance. It is neither the owner nor
        // queued, so its bootstrap has to recognise it as its own replay — and
        // its re-dispatched completion has to name the successor again, because
        // the wake step never ran and has nothing memoized to replay.
        await expect(runAgentLoop(options)).resolves.toMatchObject({ text: "done" });
        expect(woken).toStrictEqual([{ id: "wf-b", type: "agent-dequeue:thread-1:wf-b" }]);
    });
});
