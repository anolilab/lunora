import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentDefinition, AgentFunctionReference, AgentGenerate, AgentGenerateResult, AgentRunFunction, AgentToolContext } from "../src/types";

/**
 * Faithful in-memory model of Cloudflare Workflows' `step.do` memoization: a
 * step name with a recorded output returns it WITHOUT re-invoking the
 * callback. Reusing the instance across two `runAgentLoop` calls models a
 * crash + resume of the same workflow instance.
 */
class DurableStepJournal {
    public readonly invoked: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            return existing.output as T;
        }

        this.invoked.push(name);

        const output = await callback();

        this.entries.set(name, { output });

        return output;
    }
}

interface StoredMessage {
    content: string;
    messageKey: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    stepName?: string;
    threadKey: string;
    toolCallId?: string;
    toolCalls?: { id: string; input: unknown; name: string }[];
    toolName?: string;
}

interface StoredThread {
    agent: string;
    error?: string;
    key: string;
    messageCount: number;
    status: string;
    title?: string;
}

/**
 * In-memory double of the agent runtime functions (`agents:*`), dispatched by
 * `__lunoraRef` exactly like the real `/_lunora/scheduler/dispatch` runner —
 * with the same idempotency semantics the component's mutations implement
 * (keyed appends, get-or-create threads, counter-allocated seq).
 */
const memoryRuntime = (options?: {
    memory?: { path: string; result: unknown };
}): {
    dispatches: { args: Record<string, unknown> | undefined; path: string }[];
    messages: Map<string, StoredMessage>;
    run: AgentRunFunction;
    threads: Map<string, StoredThread>;
} => {
    const threads = new Map<string, StoredThread>();
    const messages = new Map<string, StoredMessage>();
    const dispatches: { args: Record<string, unknown> | undefined; path: string }[] = [];

    const ensureThread = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;
        const existing = threads.get(key);

        if (existing) {
            existing.status = "running";
            delete existing.error;

            return { created: false };
        }

        threads.set(key, {
            agent: args?.["agent"] as string,
            key,
            messageCount: 0,
            status: "running",
            title: args?.["title"] as string | undefined,
        });

        return { created: true };
    };

    const appendMessage = (args?: Record<string, unknown>): unknown => {
        const threadKey = args?.["threadKey"] as string;
        const messageKey = args?.["messageKey"] as string;
        const id = `${threadKey}:${messageKey}`;
        const existing = messages.get(id);

        if (existing) {
            return { seq: existing.seq };
        }

        const thread = threads.get(threadKey);

        if (!thread) {
            throw new Error(`unknown thread ${threadKey}`);
        }

        const seq = thread.messageCount;

        thread.messageCount += 1;
        messages.set(id, { ...(args as unknown as StoredMessage), seq });

        return { seq };
    };

    const listMessages = (args?: Record<string, unknown>): unknown => {
        const key = args?.["key"] as string;

        return [...messages.values()].filter((message) => message.threadKey === key).toSorted((a, b) => a.seq - b.seq);
    };

    const patchThread = (args?: Record<string, unknown>): unknown => {
        const thread = threads.get(args?.["key"] as string);

        if (thread) {
            if (args?.["status"] !== undefined) {
                thread.status = args["status"] as string;
            }

            if (args?.["error"] !== undefined) {
                thread.error = args["error"] as string;
            }
        }

        return undefined;
    };

    const handlers = new Map<string, (args?: Record<string, unknown>) => unknown>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, appendMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, ensureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, listMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, patchThread],
        ...(options?.memory ? ([[options.memory.path, (): unknown => options.memory?.result]] as const) : []),
    ]);

    const run: AgentRunFunction = async (reference: AgentFunctionReference, args?: Record<string, unknown>) => {
        const path = reference["__lunoraRef"];

        dispatches.push({ args, path });

        const handler = handlers.get(path);

        if (!handler) {
            throw new Error(`unexpected dispatch: ${path}`);
        }

        return handler(args);
    };

    return { dispatches, messages, run, threads };
};

/** A scripted LLM: pops one decision per turn, records what it was shown. */
const scriptedGenerate = (script: AgentGenerateResult[]): AgentGenerate & { seen: ReadonlyArray<unknown>[] } => {
    const seen: ReadonlyArray<unknown>[] = [];
    const remaining = [...script];

    const generate = (async ({ messages }: { messages: ReadonlyArray<unknown> }) => {
        seen.push(messages);

        const next = remaining.shift();

        if (!next) {
            throw new Error("scripted generate exhausted");
        }

        return next;
    }) as AgentGenerate & { seen: ReadonlyArray<unknown>[] };

    generate.seen = seen;

    return generate;
};

const finalTurn = (text: string): AgentGenerateResult => {
    return { text, toolCalls: [] };
};

const toolTurn = (id: string, name: string, input: unknown, text = ""): AgentGenerateResult => {
    return { text, toolCalls: [{ id, input, name }] };
};

const loopDefaults = (agent: AgentDefinition, overrides?: Partial<Parameters<typeof runAgentLoop>[0]>): Parameters<typeof runAgentLoop>[0] => {
    return {
        agent,
        env: { LUNORA_TEST: true },
        exportName: "support",
        generate: scriptedGenerate([finalTurn("hi")]),
        instanceId: "wf-1",
        params: { input: "hello", threadKey: "thread-1" },
        paths: DEFAULT_AGENT_FUNCTION_PATHS,
        run: memoryRuntime().run,
        step: new DurableStepJournal(),
        ...overrides,
    };
};

describe(runAgentLoop, () => {
    it("persists an ordered thread: user → assistant(tool call) → tool → final", async () => {
        const toolContexts: AgentToolContext[] = [];
        let toolRuns = 0;

        const agent = defineAgent({
            instructions: "You are a weather agent.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                getWeather: defineAgentTool({
                    description: "Look up the weather.",
                    execute: (input: { city: string }, context) => {
                        toolRuns += 1;
                        toolContexts.push(context);

                        return `sunny in ${input.city}`;
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "getWeather", { city: "Berlin" }, "checking…"), finalTurn("It is sunny in Berlin.")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "It is sunny in Berlin.", turns: 2 });

        const thread = [...runtime.messages.values()].toSorted((a, b) => a.seq - b.seq);

        expect(thread.map((message) => [message.seq, message.role, message.content])).toStrictEqual([
            [0, "user", "hello"],
            [1, "assistant", "checking…"],
            [2, "tool", "sunny in Berlin"],
            [3, "assistant", "It is sunny in Berlin."],
        ]);
        expect(thread[1]?.toolCalls).toStrictEqual([{ id: "call_1", input: { city: "Berlin" }, name: "getWeather" }]);
        expect(thread[2]?.toolCallId).toBe("call_1");
        expect(thread[2]?.toolName).toBe("getWeather");
        expect(toolRuns).toBe(1);

        // The tool saw its durable identity: the step name doubles as the
        // idempotency key, plus the thread + call correlation and the env.
        expect(toolContexts[0]?.idempotencyKey).toBe("tool:getWeather:call_1");
        expect(toolContexts[0]?.threadKey).toBe("thread-1");
        expect(toolContexts[0]?.toolCallId).toBe("call_1");
        expect(toolContexts[0]?.env).toStrictEqual({ LUNORA_TEST: true });

        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:getWeather:call_1", "llm:turn:1"]);
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("never re-runs a completed tool step across a crash + resume", async () => {
        let toolRuns = 0;

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => {
                        toolRuns += 1;

                        return "charged";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        // First attempt: the tool completes, then the process dies before the
        // next LLM turn (the scripted generate throws on its second call).
        const crashing = scriptedGenerate([toolTurn("call_9", "charge", { amount: 100 })]);

        await expect(runAgentLoop(loopDefaults(agent, { generate: crashing, run: runtime.run, step: journal }))).rejects.toThrow("scripted generate exhausted");
        expect(toolRuns).toBe(1);
        expect(runtime.threads.get("thread-1")?.status).toBe("error");

        // Resume: same journal (Cloudflare replays the same instance) + same
        // store. Turn 0 and the tool are served from the journal — the charge
        // does NOT run again — and the loop completes.
        const resumed = scriptedGenerate([finalTurn("done")]);
        const result = await runAgentLoop(loopDefaults(agent, { generate: resumed, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(toolRuns).toBe(1);

        // COMPLETED steps ran exactly once across both attempts; the crashed
        // `llm:turn:1` was legitimately retried on resume (at-least-once for
        // failed bodies is the durable-execution contract — the memoization
        // guarantee protects completed side effects, like the charge).
        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:charge:call_9", "llm:turn:1", "llm:turn:1"]);
        expect(journal.invoked.filter((name) => name === "tool:charge:call_9")).toHaveLength(1);

        // No duplicated messages: user + assistant(call) + tool + final.
        const thread = [...runtime.messages.values()].toSorted((a, b) => a.seq - b.seq);

        expect(thread.map((message) => message.role)).toStrictEqual(["user", "assistant", "tool", "assistant"]);
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("runs the memory step once and injects the retrieved context", async () => {
        const memoryResult = { chunks: [], context: "[source:doc-1#0]\nLunora runs on Durable Objects.", sources: [{ id: "doc-1" }] };
        const runtime = memoryRuntime({ memory: { path: "rag:searchDocs", result: memoryResult } });
        const generate = scriptedGenerate([finalTurn("answered")]);

        const agent = defineAgent({
            memory: { source: "rag:searchDocs", topK: 3 },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        });

        const journal = new DurableStepJournal();

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(journal.invoked[0]).toBe("memory:retrieve");

        const memoryDispatch = runtime.dispatches.find((dispatch) => dispatch.path === "rag:searchDocs");

        expect(memoryDispatch?.args).toStrictEqual({ query: "hello", topK: 3 });

        // The system message carrying the retrieved context reached the model.
        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes("Lunora runs on Durable Objects."))).toBe(true);
    });

    it("forwards the run owner to the thread bootstrap", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();

        await runAgentLoop(
            loopDefaults(agent, {
                generate: scriptedGenerate([finalTurn("hi")]),
                params: { input: "hello", owner: "user-a", threadKey: "thread-1" },
                run: runtime.run,
            }),
        );

        const bootstrap = runtime.dispatches.find((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread);

        expect(bootstrap?.args).toMatchObject({ agent: "support", key: "thread-1", owner: "user-a" });
    });

    it("stops at maxTurns and marks the thread errored", async () => {
        const agent = defineAgent({
            maxTurns: 2,
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                loop: defineAgentTool({
                    description: "Loops forever.",
                    execute: () => "again",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const generate = scriptedGenerate([toolTurn("c1", "loop", {}), toolTurn("c2", "loop", {})]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(result).toStrictEqual({ stopped: "maxTurns", turns: 2 });
        expect(runtime.threads.get("thread-1")?.status).toBe("error");
        expect(runtime.threads.get("thread-1")?.error).toContain("maxTurns");
    });

    it("records a hallucinated tool name as an error result and lets the model recover", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();
        const generate = scriptedGenerate([toolTurn("c1", "notARealTool", {}), finalTurn("sorry, no such tool")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(result.stopped).toBe("final");

        const toolMessage = [...runtime.messages.values()].find((message) => message.role === "tool");

        expect(toolMessage?.content).toContain('unknown tool "notARealTool"');
    });

    it("marks the thread errored and rethrows when a turn fails terminally", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();
        const generate = (async () => {
            throw new Error("model unavailable");
        }) as unknown as AgentGenerate;

        await expect(runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }))).rejects.toThrow("model unavailable");
        expect(runtime.threads.get("thread-1")?.status).toBe("error");
        expect(runtime.threads.get("thread-1")?.error).toBe("model unavailable");
    });
});
