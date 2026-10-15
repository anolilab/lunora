import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "../src/paths";
import type { AgentCompact, AgentGenerate } from "../src/types";
import { DurableStepJournal, finalTurn, loopDefaults, memoryRuntime, scriptedGenerate } from "./loop-harness";

const agent = defineAgent({ compaction: { keepRecent: 5, maxMessages: 10 }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });

type Runtime = ReturnType<typeof memoryRuntime>;

const appendMore = async (runtime: Runtime, from: number, count: number): Promise<void> => {
    for (let index = from; index < from + count; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- seq is allocated in append order
        await runtime.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.appendMessage), {
            content: `m${String(index)}`,
            messageKey: `seed:${String(index)}`,
            role: "user",
            threadKey: "thread-1",
        });
    }
};

/** A runtime whose thread already holds `count` messages (seq 0..count-1). */
const seeded = async (count: number): Promise<Runtime> => {
    const runtime = memoryRuntime();

    await runtime.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.ensureThread), { agent: "support", instanceId: "wf-1", key: "thread-1" });
    await appendMore(runtime, 0, count);

    return runtime;
};

/** A generate seam that records each turn's serialised prompt. */
const promptCapture = (): { generate: AgentGenerate; prompts: string[] } => {
    const prompts: string[] = [];
    const generate: AgentGenerate = async (options) => {
        prompts.push(JSON.stringify(options.messages));

        return finalTurn("ok");
    };

    return { generate, prompts };
};

const turn = async (runtime: Runtime, compact: AgentCompact, step = new DurableStepJournal(), input = "next"): Promise<void> => {
    await runAgentLoop(
        loopDefaults(agent, { compact, generate: scriptedGenerate([finalTurn("ok")]), params: { input, threadKey: "thread-1" }, run: runtime.run, step }),
    );
};

/** A runtime wrapper that records how many messages each `agentHistory` read returned. */
const captureHistory = (runtime: Runtime): { run: typeof runtime.run; sizes: number[] } => {
    const sizes: number[] = [];
    const run: typeof runtime.run = async (reference, args) => {
        const result = await runtime.run(reference, args);

        if (JSON.stringify(reference).includes("agentHistory")) {
            sizes.push((result as { messages: unknown[] }).messages.length);
        }

        return result;
    };

    return { run, sizes };
};

describe("incremental compaction", () => {
    it("summarises only the newly aged-out messages on the second turn and stores the cursor", async () => {
        const runtime = await seeded(50);
        const sizes: number[] = [];
        const compact: AgentCompact = async ({ messages }) => {
            sizes.push(messages.length);

            return `brief${String(sizes.length)}`;
        };

        await turn(runtime, compact);

        // 51 rows (50 seeded + the user turn), keepRecent 5 -> 46 aged out, no previous brief.
        expect(sizes).toStrictEqual([46]);
        expect(runtime.threads.get("thread-1")?.summaryThroughSeq).toBe(45);

        await appendMore(runtime, 100, 10);
        await turn(runtime, compact, new DurableStepJournal(), "again");

        // Uncovered rows only: the previous brief plus the newly aged-out rows, not 46+ again.
        expect(sizes).toHaveLength(2);
        expect(sizes[1]).toBeLessThan(20);
        expect(runtime.threads.get("thread-1")?.summary).toBe("brief2");
    });

    it("does not re-summarise or re-write when the memoised step replays", async () => {
        const runtime = await seeded(50);
        let calls = 0;
        const compact: AgentCompact = async () => {
            calls += 1;

            return "brief";
        };
        const journal = new DurableStepJournal();

        await turn(runtime, compact, journal);
        await turn(runtime, compact, journal);

        expect(calls).toBe(1);
    });

    it("never summarises a thread under maxMessages", async () => {
        const runtime = await seeded(3);
        const compact = vi.fn<AgentCompact>(async () => "brief");

        await turn(runtime, compact);

        expect(compact).not.toHaveBeenCalled();
        expect(runtime.threads.get("thread-1")?.summary).toBeUndefined();
    });

    it("drops a replaced run's late summary write instead of rolling back the newer checkpoint", async () => {
        const runtime = await seeded(50);
        const compact: AgentCompact = async () => {
            // A replacement run takes the thread and checkpoints further while this run is still summarising.
            const thread = runtime.threads.get("thread-1");

            if (thread) {
                Object.assign(thread, { instanceId: "wf-2", summary: "newer", summaryRebuiltSeq: 44, summaryThroughSeq: 49 });
            }

            return "stale";
        };

        await turn(runtime, compact);

        expect(runtime.threads.get("thread-1")).toMatchObject({ summary: "newer", summaryRebuiltSeq: 44, summaryThroughSeq: 49 });
    });

    it("falls back to the stored brief plus the tail when a rebuild fails, and stops re-reading the thread", async () => {
        const runtime = await seeded(50);
        const thread = runtime.threads.get("thread-1");

        // A rebuild is due (the anchor sits behind the covered span), and the summariser is down.
        Object.assign(thread ?? {}, { summary: "storedbrief", summaryConfig: "10:5", summaryRebuiltSeq: 0, summaryThroughSeq: 44 });

        const { run, sizes: historySizes } = captureHistory(runtime);
        const { generate, prompts } = promptCapture();
        let calls = 0;
        const compact: AgentCompact = async () => {
            calls += 1;

            throw new Error("summariser down");
        };
        const runTurn = async (input: string): Promise<void> => {
            await runAgentLoop(loopDefaults(agent, { compact, generate, params: { input, threadKey: "thread-1" }, run, step: new DurableStepJournal() }));
        };

        await runTurn("one");

        expect(calls).toBe(1);
        expect(prompts[0]).toContain("storedbrief");
        // 51 rows total; the tail after seq 44 is 6 rows, not the whole thread.
        expect(prompts[0]).not.toContain('"m0"');
        expect(runtime.threads.get("thread-1")).toMatchObject({ summary: "storedbrief", summaryRebuiltSeq: 44, summaryThroughSeq: 44 });

        await runTurn("two");

        expect(historySizes[0]).toBeGreaterThanOrEqual(51);
        expect(historySizes[1]).toBeLessThan(15);
    });

    it("uses a fresh summary for the turn when persisting the checkpoint fails, leaving the cursor for a retry", async () => {
        const runtime = await seeded(50);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const run: typeof runtime.run = async (reference, args) => {
            if (JSON.stringify(reference).includes("agentPatchThread") && args?.["summary"] !== undefined) {
                throw new Error("write failed");
            }

            return runtime.run(reference, args);
        };
        const { generate, prompts } = promptCapture();
        const compact: AgentCompact = async () => "freshbrief";

        await runAgentLoop(loopDefaults(agent, { compact, generate, params: { input: "next", threadKey: "thread-1" }, run, step: new DurableStepJournal() }));

        expect(prompts[0]).toContain("freshbrief");
        expect(prompts[0]).not.toContain('"m0"');
        expect(runtime.threads.get("thread-1")?.summary).toBeUndefined();
        expect(runtime.threads.get("thread-1")?.summaryThroughSeq).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist"), expect.any(Error));

        warn.mockRestore();
    });

    it("still degrades to the full history when the compactor throws and nothing is stored", async () => {
        const runtime = await seeded(50);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { generate, prompts } = promptCapture();
        const compact: AgentCompact = async () => {
            throw new Error("summariser down");
        };

        await runAgentLoop(
            loopDefaults(agent, { compact, generate, params: { input: "next", threadKey: "thread-1" }, run: runtime.run, step: new DurableStepJournal() }),
        );

        expect(prompts[0]).toContain('"m0"');
        expect(runtime.threads.get("thread-1")?.summary).toBeUndefined();

        warn.mockRestore();
    });

    it("reads the full history when the stored summary was built under different compaction settings", async () => {
        const runtime = await seeded(50);

        // The stored brief came from a NARROWER `maxMessages` (5), so its cursor hides messages the
        // current agent (maxMessages 10) would keep. The loop must rebuild rather than apply it.
        Object.assign(runtime.threads.get("thread-1") ?? {}, { summary: "oldbrief", summaryConfig: "5:2", summaryRebuiltSeq: 45, summaryThroughSeq: 45 });

        const sizes: number[] = [];
        const compact: AgentCompact = async ({ messages }) => {
            sizes.push(messages.length);

            return "newbrief";
        };

        await turn(runtime, compact);

        // Full history (51 rows) reaches the compactor, not just the 5 rows after the stale cursor.
        expect(sizes[0]).toBeGreaterThan(40);
        expect(runtime.threads.get("thread-1")).toMatchObject({ summary: "newbrief", summaryConfig: "10:5" });
    });

    it("passes the previous brief to the compactor so an incremental update merges instead of replacing", async () => {
        const runtime = await seeded(50);
        const seen: (string | undefined)[] = [];
        const compact: AgentCompact = async ({ previousSummary }) => {
            seen.push(previousSummary);

            return `brief${String(seen.length)}`;
        };

        await turn(runtime, compact);
        await appendMore(runtime, 100, 10);
        await turn(runtime, compact, new DurableStepJournal(), "again");

        // First turn is from scratch (no brief to merge); the second carries the stored one.
        expect(seen[0]).toBeUndefined();
        expect(seen[1]).toBe("brief1");
    });

    it("holds off the from-scratch rebuild until the covered span doubles", async () => {
        const runtime = await seeded(50);
        const { run, sizes: historySizes } = captureHistory(runtime);
        const compact: AgentCompact = async () => "brief";

        // Anchored by a rebuild at seq 44: the next rebuild is due once the cursor reaches 2*44+1 = 89.
        Object.assign(runtime.threads.get("thread-1") ?? {}, { summary: "brief", summaryConfig: "10:5", summaryRebuiltSeq: 44, summaryThroughSeq: 44 });

        const runTurn = async (input: string): Promise<void> => {
            await runAgentLoop(
                loopDefaults(agent, {
                    compact,
                    generate: scriptedGenerate([finalTurn("ok")]),
                    params: { input, threadKey: "thread-1" },
                    run,
                    step: new DurableStepJournal(),
                }),
            );
        };

        await runTurn("a");

        // Below the doubled span: only the uncovered tail is read, never the whole thread.
        expect(historySizes[0]).toBeLessThan(15);

        // Push the cursor to the doubled span; the next turn rebuilds from the whole thread.
        Object.assign(runtime.threads.get("thread-1") ?? {}, { summaryThroughSeq: 89 });
        await runTurn("b");

        expect(historySizes[1]).toBeGreaterThanOrEqual(50);
    });
});
