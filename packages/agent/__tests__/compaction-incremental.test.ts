import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "../src/paths";
import type { AgentCompact } from "../src/types";
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

    await runtime.run(toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.ensureThread), { agent: "support", key: "thread-1" });
    await appendMore(runtime, 0, count);

    return runtime;
};

const turn = async (runtime: Runtime, compact: AgentCompact, step = new DurableStepJournal(), input = "next"): Promise<void> => {
    await runAgentLoop(
        loopDefaults(agent, { compact, generate: scriptedGenerate([finalTurn("ok")]), params: { input, threadKey: "thread-1" }, run: runtime.run, step }),
    );
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
});
