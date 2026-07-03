/**
 * Spike 113 PoC test. Asserts the two properties the plan requires:
 *   (a) the message thread is persisted in order (user -> assistant tool-call ->
 *       tool result -> final assistant), and
 *   (b) on a simulated mid-loop crash + resume, the already-completed tool step is
 *       NOT re-executed (no double side effect) and completed LLM turns are not
 *       re-called.
 */
import { describe, expect, it } from "vitest";

import type { AgentDeps, LlmTurn, ThreadMessage } from "./agent-loop";
import { DurableStepJournal, MessageStore, runAgent } from "./agent-loop";

/** Build a mock LLM that returns one tool call on turn 0, then a final answer on turn 1. */
const makeLlm = (): { fn: AgentDeps["llm"]; turns: number } => {
    const state = { turns: 0 };

    const fn = (): LlmTurn => {
        const current = state.turns;

        state.turns += 1;

        if (current === 0) {
            return { args: { city: "SF" }, id: "call_1", kind: "tool_call", name: "getWeather", text: "let me check the weather" };
        }

        return { kind: "final", text: "It is 21C and sunny in SF." };
    };

    return {
        fn,
        get turns() {
            return state.turns;
        },
    };
};

/** Deterministic clock so `createdAt` is stable across the crash + resume. */
const makeClock = () => {
    let tick = 0;

    return () => {
        tick += 1;

        return `2026-07-03T00:00:${String(tick).padStart(2, "0")}Z`;
    };
};

describe("spike 113: durable single-tool agent loop", () => {
    it("persists the thread in order across LLM -> tool -> LLM", async () => {
        const llm = makeLlm();
        const toolCalls: unknown[] = [];

        const messages = await runAgent({
            journal: new DurableStepJournal(),
            llm: llm.fn,
            messages: new MessageStore(),
            now: makeClock(),
            threadId: "t1",
            tool: {
                handler: (args) => {
                    toolCalls.push(args);

                    return "21C sunny";
                },
                name: "getWeather",
            },
            userInput: "what's the weather in SF?",
        });

        expect(messages.map((message: ThreadMessage) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(messages.map((message) => message.seq)).toEqual([0, 1, 2, 3]);
        expect(messages[1].toolCall).toEqual({ args: { city: "SF" }, id: "call_1", name: "getWeather" });
        expect(messages[2].toolCallId).toBe("call_1");
        expect(messages[3].content).toContain("sunny");
        expect(toolCalls).toHaveLength(1);
    });

    it("does not re-run a completed tool step on resume after a mid-loop crash", async () => {
        // Shared, DURABLE state that survives the crash (the DO's SQLite + the
        // Workflows step journal in the real design).
        const journal = new DurableStepJournal();
        const messages = new MessageStore();
        const clock = makeClock();

        const sideEffects = { count: 0 };
        const llm = makeLlm();

        const tool = {
            handler: (): string => {
                sideEffects.count += 1; // e.g. "charge the card" — must happen exactly once

                return "21C sunny";
            },
            name: "getWeather",
        };

        // First attempt: crash right after the tool step commits, before turn 1's LLM call.
        let crashed = false;

        await expect(
            runAgent({
                checkpoint: (label) => {
                    if (label === "after-tool:call_1") {
                        crashed = true;

                        throw new Error("SIMULATED_CRASH");
                    }
                },
                journal,
                llm: llm.fn,
                messages,
                now: clock,
                threadId: "t1",
                tool,
                userInput: "what's the weather in SF?",
            }),
        ).rejects.toThrow("SIMULATED_CRASH");

        expect(crashed).toBe(true);
        expect(sideEffects.count).toBe(1); // tool ran once pre-crash
        expect(journal.has("tool:getWeather:call_1")).toBe(true); // recorded in the journal
        expect(journal.has("llm:turn:1")).toBe(false); // never reached

        // RESUME: same journal + same message store, no checkpoint crash this time.
        const invokedBeforeResume = [...journal.invoked];
        const finalMessages = await runAgent({
            journal,
            llm: llm.fn,
            messages,
            now: clock,
            threadId: "t1",
            tool,
            userInput: "what's the weather in SF?",
        });

        // (b) The tool did NOT run again — memoized by its step name.
        expect(sideEffects.count).toBe(1);
        // Each step body was invoked EXACTLY ONCE across the crash + resume: the two
        // completed steps (llm:turn:0, tool:getWeather:call_1) ran pre-crash and were
        // served from the journal on resume; only the new step (llm:turn:1) ran on resume.
        expect(invokedBeforeResume).toEqual(["llm:turn:0", "tool:getWeather:call_1"]);
        expect(journal.invoked).toEqual(["llm:turn:0", "tool:getWeather:call_1", "llm:turn:1"]);

        // (a) The resumed thread is complete + in order, with no duplicated messages.
        expect(finalMessages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(finalMessages.map((message) => message.id)).toEqual(["t1:user:0", "t1:assistant:0", "t1:tool:call_1", "t1:assistant:1"]);
        expect(finalMessages[3].content).toContain("sunny");
    });
});
