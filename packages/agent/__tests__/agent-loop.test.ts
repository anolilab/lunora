import { hasToolCall } from "ai";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type {
    AgentDefinition,
    AgentFunctionReference,
    AgentGenerate,
    AgentGenerateResult,
    AgentRunFunction,
    AgentStepFinishInfo,
    AgentStreamGenerate,
    AgentTokenDelta,
    AgentTokenSink,
    AgentToolContext,
} from "../src/types";

const IN_FLIGHT_PATTERN = /already has a run in flight/u;

/**
 * Faithful in-memory model of Cloudflare Workflows' `step.do` memoization: a
 * step name with a recorded output returns it WITHOUT re-invoking the
 * callback. Reusing the instance across two `runAgentLoop` calls models a
 * crash + resume of the same workflow instance.
 */
class DurableStepJournal {
    public readonly invoked: string[] = [];

    /** External events delivered to the instance (name → payload), seeded by a test's simulated `sendEvent`. */
    public readonly events = new Map<string, unknown>();

    /** Names the run hibernated on (a `waitForEvent` that had no event yet). */
    public readonly waitedNames: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    private readonly resolvedWaits = new Map<string, { payload: unknown }>();

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

    /**
     * Faithful model of `step.waitForEvent`: a resolved wait is memoized (a
     * replay returns the recorded payload without pausing), an event already
     * delivered resolves immediately, and an undelivered event HIBERNATES — the
     * promise never resolves this invocation, exactly as Cloudflare freezes the
     * instance until the event arrives (it does NOT throw into the handler).
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
    public async waitForEvent<T>(name: string, options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> {
        const memo = this.resolvedWaits.get(name);

        if (memo) {
            return { payload: memo.payload as T, type: options.type };
        }

        if (this.events.has(name)) {
            const payload = this.events.get(name);

            this.resolvedWaits.set(name, { payload });

            return { payload: payload as T, type: options.type };
        }

        this.waitedNames.push(name);

        // Hibernate: this invocation never gets past here (see the doc above).
        return new Promise<{ payload: T; type: string }>(() => {});
    }
}

/** Drain the microtask queue so a paused run reaches its `waitForEvent` hibernation. */
const flushMicrotasks = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

interface StoredMessage {
    content: string;
    messageKey: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    status?: "approved" | "awaiting_approval" | "rejected";
    stepName?: string;
    threadKey: string;
    toolCallId?: string;
    toolCalls?: { id: string; input: unknown; name: string }[];
    toolName?: string;
}

interface StoredThread {
    agent: string;
    error?: string;
    instanceId?: string;
    key: string;
    messageCount: number;
    status: string;
    title?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
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
        const instanceId = args?.["instanceId"] as string | undefined;
        const existing = threads.get(key);

        if (existing) {
            // Mirror the real component's concurrency guard: a running thread
            // owned by a DIFFERENT instance is a genuine second run.
            const isConcurrentRun =
                existing.status === "running" && existing.instanceId !== undefined && instanceId !== undefined && existing.instanceId !== instanceId;

            if (isConcurrentRun) {
                const policy = (args?.["onConcurrentRun"] as string | undefined) ?? "reject";
                const priorInstanceId = existing.instanceId ?? "";

                if (policy !== "replace") {
                    throw new Error(`@lunora/agent: thread "${key}" already has a run in flight (instance "${priorInstanceId}") — onConcurrentRun="${policy}"`);
                }

                existing.status = "running";
                existing.instanceId = instanceId;
                delete existing.error;

                return { created: false, priorInstanceId, replaced: true };
            }

            existing.status = "running";
            delete existing.error;

            if (instanceId !== undefined) {
                existing.instanceId = instanceId;
            }

            return { created: false };
        }

        threads.set(key, {
            agent: args?.["agent"] as string,
            instanceId,
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

            if (args?.["usage"] !== undefined) {
                thread.usage = args["usage"] as StoredThread["usage"];
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

/** One scripted streamed turn: the deltas to tee, then the final decision it resolves to. */
interface StreamTurn {
    deltas: ReadonlyArray<string>;
    result: AgentGenerateResult;
}

/**
 * A scripted streaming LLM seam: per turn it tees each delta through `onDelta`
 * (in order), then resolves the scripted final decision — mirroring how the real
 * `streamText` seam feeds the live channel while returning the persisted turn.
 * `state.calls` counts real invocations so a test can prove a replay skipped it.
 */
const scriptedStreamGenerate = (script: StreamTurn[]): { seam: AgentStreamGenerate; state: { calls: number } } => {
    const state = { calls: 0 };
    const remaining = [...script];

    const seam: AgentStreamGenerate = async (_options, onDelta) => {
        state.calls += 1;

        const next = remaining.shift();

        if (!next) {
            throw new Error("scripted stream generate exhausted");
        }

        for (const delta of next.deltas) {
            onDelta(delta);
        }

        return next.result;
    };

    return { seam, state };
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

    it("stops on a `stopWhen` condition after a tool call and leaves the thread idle", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            stopWhen: hasToolCall("finish"),
            tools: {
                finish: defineAgentTool({
                    description: "Signal completion.",
                    execute: () => "acknowledged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        // Two turns are scripted, but the stop condition must end the loop after
        // turn 0 — the second turn is never generated.
        const generate = scriptedGenerate([toolTurn("c1", "finish", {}), finalTurn("should never run")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "stopCondition", turns: 1 });
        expect(generate.seen).toHaveLength(1);
        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:finish:c1"]);
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("lets `prepareStep` replace the history sent to the model", async () => {
        const compacted = [{ content: "COMPACTED SUMMARY", role: "user" }];

        const agent = defineAgent({
            instructions: "You are terse.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            prepareStep: ({ stepNumber }) => (stepNumber === 1 ? { messages: compacted as never } : undefined),
            tools: {
                ping: defineAgentTool({
                    description: "Ping.",
                    execute: () => "pong",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const generate = scriptedGenerate([toolTurn("c1", "ping", {}), finalTurn("done")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 2 });

        // Turn 0 saw the assembled history (system + user), turn 1 saw ONLY the
        // compacted replacement `prepareStep` returned.
        expect(generate.seen[1]).toStrictEqual(compacted);

        const firstTurn = generate.seen[0] as { role: string }[];

        expect(firstTurn.some((message) => message.role === "system")).toBe(true);
    });

    it("surfaces a structured `output` on the result and persists it as JSON", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            output: { jsonSchema: { type: "object" } } as never,
        });

        const runtime = memoryRuntime();
        // A structured-output turn: no text, an `output` object instead.
        const generate = scriptedGenerate([{ output: { answer: 42, unit: "celsius" }, text: "", toolCalls: [] }]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(result).toStrictEqual({ output: { answer: 42, unit: "celsius" }, stopped: "final", text: "", turns: 1 });

        // The final assistant message carries the JSON-encoded structured answer.
        const finalMessage = [...runtime.messages.values()].toSorted((a, b) => a.seq - b.seq).at(-1);

        expect(finalMessage?.content).toBe(JSON.stringify({ answer: 42, unit: "celsius" }));
    });

    it("accumulates token usage across turns and patches it onto the thread", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                lookup: defineAgentTool({
                    description: "Look something up.",
                    execute: () => "value",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const generate = scriptedGenerate([
            { text: "", toolCalls: [{ id: "c1", input: {}, name: "lookup" }], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            { text: "final", toolCalls: [], usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
        ]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(result).toStrictEqual({
            stopped: "final",
            text: "final",
            turns: 2,
            usage: { inputTokens: 30, outputTokens: 13, totalTokens: 43 },
        });
        expect(runtime.threads.get("thread-1")?.usage).toStrictEqual({ inputTokens: 30, outputTokens: 13, totalTokens: 43 });
    });

    it("invokes `onStepFinish` once per turn as a durable step", async () => {
        const steps: AgentStepFinishInfo[] = [];

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            onStepFinish: (info) => {
                steps.push(info);
            },
            tools: {
                act: defineAgentTool({
                    description: "Act.",
                    execute: () => "acted",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("c1", "act", { n: 1 }, "acting"), finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(steps).toHaveLength(2);
        expect(steps[0]).toStrictEqual({ text: "acting", toolCalls: [{ id: "c1", input: { n: 1 }, name: "act" }], turn: 0 });
        expect(steps[1]).toStrictEqual({ text: "done", toolCalls: [], turn: 1 });
        expect(journal.invoked).toContain("agent:step-finish:0");
        expect(journal.invoked).toContain("agent:step-finish:1");
    });

    it("rejects a second run while the thread is running under another instance", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", onConcurrentRun: "reject" });
        const runtime = memoryRuntime();

        // Seed a thread already in flight for the FIRST run (a different instance).
        runtime.threads.set("thread-1", { agent: "support", instanceId: "wf-first", key: "thread-1", messageCount: 1, status: "running" });

        await expect(
            runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("hi")]), instanceId: "wf-second", run: runtime.run })),
        ).rejects.toThrow(IN_FLIGHT_PATTERN);

        // The in-flight run's thread is untouched — the rejected run patches nothing.
        expect(runtime.threads.get("thread-1")?.status).toBe("running");
        expect(runtime.threads.get("thread-1")?.instanceId).toBe("wf-first");
        expect(runtime.threads.get("thread-1")?.messageCount).toBe(1);
    });

    it("allows a replay of the SAME instance on a running thread (not a concurrent run)", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", onConcurrentRun: "reject" });
        const runtime = memoryRuntime();

        // The thread is "running" under wf-1; a workflow replay re-enters the
        // bootstrap under that SAME id, which the guard must not reject.
        runtime.threads.set("thread-1", { agent: "support", instanceId: "wf-1", key: "thread-1", messageCount: 0, status: "running" });

        const result = await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("resumed")]), instanceId: "wf-1", run: runtime.run }));

        expect(result).toStrictEqual({ stopped: "final", text: "resumed", turns: 1 });
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("replaces a prior run: terminates its instance and takes the thread over", async () => {
        const terminated: string[] = [];
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", onConcurrentRun: "replace" });
        const runtime = memoryRuntime();

        runtime.threads.set("thread-1", { agent: "support", instanceId: "wf-old", key: "thread-1", messageCount: 3, status: "running" });

        // The loop resolves AGENT_SUPPORT off env to terminate the prior instance.
        const binding = {
            create: async () => {
                return { id: "unused" };
            },
            get: async (id: string) => {
                return {
                    status: async () => {
                        return {};
                    },
                    terminate: async () => {
                        terminated.push(id);
                    },
                };
            },
        };

        const result = await runAgentLoop(
            loopDefaults(agent, {
                env: { AGENT_SUPPORT: binding, LUNORA_TEST: true },
                generate: scriptedGenerate([finalTurn("took over")]),
                instanceId: "wf-new",
                run: runtime.run,
            }),
        );

        expect(terminated).toStrictEqual(["wf-old"]);
        expect(result).toStrictEqual({ stopped: "final", text: "took over", turns: 1 });
        expect(runtime.threads.get("thread-1")?.instanceId).toBe("wf-new");
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("pauses a needsApproval tool, resumes on approve, and runs it exactly once across a replay", async () => {
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
                    needsApproval: true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("done")]);

        // Phase A — the run pauses on the approval and never gets past it.
        const paused = runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        paused.catch(() => {
            /* the paused invocation never settles — Cloudflare freezes it */
        });
        await flushMicrotasks();

        expect(toolRuns).toBe(0);
        expect(journal.waitedNames).toStrictEqual(["approval:call_1"]);
        expect(journal.invoked).not.toContain("tool:charge:call_1");
        expect(runtime.threads.get("thread-1")?.status).toBe("awaiting_input");

        // The awaiting-approval marker is persisted; the tool result is not yet.
        const marker = [...runtime.messages.values()].find((message) => message.status === "awaiting_approval");

        expect(marker?.toolName).toBe("charge");

        // Phase B — a client approves; the SAME workflow instance replays (same
        // journal + store), the memoized turn/marker are skipped, and the tool runs.
        journal.events.set("approval:call_1", { decision: "approve" });

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(toolRuns).toBe(1);

        const approvedResult = [...runtime.messages.values()].find((message) => message.status === "approved");

        expect(approvedResult?.content).toBe("charged");
        expect(approvedResult?.toolCallId).toBe("call_1");
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");

        // Phase C — another replay of the resolved run charges NOTHING more.
        const replay = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(replay).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(toolRuns).toBe(1);
        expect(journal.invoked.filter((name) => name === "tool:charge:call_1")).toHaveLength(1);
    });

    it("skips a rejected tool and persists a recoverable result the model sees next turn", async () => {
        let toolRuns = 0;

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                deleteAccount: defineAgentTool({
                    description: "Delete the account.",
                    execute: () => {
                        toolRuns += 1;

                        return "deleted";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: () => true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        // The decision is already delivered, so the wait resolves without pausing.
        journal.events.set("approval:call_1", { decision: "reject", note: "too risky" });
        const generate = scriptedGenerate([toolTurn("call_1", "deleteAccount", {}, "deleting…"), finalTurn("understood, cancelled")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(result).toStrictEqual({ stopped: "final", text: "understood, cancelled", turns: 2 });

        // The tool never ran, and no `tool:` step was recorded for it.
        expect(toolRuns).toBe(0);
        expect(journal.invoked).not.toContain("tool:deleteAccount:call_1");

        // A rejected tool RESULT (not the marker) is persisted, carrying the note,
        // and it is the tool-result the model saw on the recovering turn.
        const rejected = [...runtime.messages.values()].find((message) => message.status === "rejected");

        expect(rejected?.toolCallId).toBe("call_1");
        expect(rejected?.content).toContain("rejected by the user");
        expect(rejected?.content).toContain("too risky");

        const recoveringTurn = generate.seen[1] as { content: { output: { value: string }; toolCallId: string }[]; role: string }[];
        const toolResult = recoveringTurn.find((message) => message.role === "tool");

        expect(String(toolResult?.content[0]?.output.value)).toContain("rejected by the user");
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
    });

    it("streams token deltas in order and persists the concatenated final text", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();

        const deltas: AgentTokenDelta[] = [];
        const onTokenDelta: AgentTokenSink = (delta) => {
            deltas.push(delta);
        };
        const stream = scriptedStreamGenerate([{ deltas: ["It ", "is ", "sunny."], result: finalTurn("It is sunny.") }]);

        const result = await runAgentLoop(loopDefaults(agent, { onTokenDelta, run: runtime.run, streamGenerate: stream.seam }));

        expect(result).toStrictEqual({ stopped: "final", text: "It is sunny.", turns: 1 });

        // Deltas arrive in order, each keyed to the thread + the turn producing it.
        expect(deltas).toStrictEqual([
            { text: "It ", threadKey: "thread-1", turn: 0 },
            { text: "is ", threadKey: "thread-1", turn: 0 },
            { text: "sunny.", threadKey: "thread-1", turn: 0 },
        ]);

        // The persisted assistant message is the single source of truth: it equals
        // the concatenation of the (ephemeral) deltas.
        const finalMessage = [...runtime.messages.values()].toSorted((a, b) => a.seq - b.seq).at(-1);

        expect(finalMessage?.role).toBe("assistant");
        expect(finalMessage?.content).toBe(deltas.map((delta) => delta.text).join(""));
        expect(stream.state.calls).toBe(1);
    });

    it("re-emits NO deltas on a replay of a completed turn but returns the memoized value", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        const deltas: AgentTokenDelta[] = [];
        const onTokenDelta: AgentTokenSink = (delta) => {
            deltas.push(delta);
        };
        // A single scripted turn — a replay must NOT reach the (now-exhausted) seam.
        const stream = scriptedStreamGenerate([{ deltas: ["hel", "lo"], result: finalTurn("hello") }]);

        const first = await runAgentLoop(loopDefaults(agent, { onTokenDelta, run: runtime.run, step: journal, streamGenerate: stream.seam }));

        expect(first).toStrictEqual({ stopped: "final", text: "hello", turns: 1 });
        expect(deltas.map((delta) => delta.text)).toStrictEqual(["hel", "lo"]);
        expect(stream.state.calls).toBe(1);

        // Replay the SAME instance (same journal + store). The memoized `llm:turn:0`
        // is served WITHOUT re-running its body, so the stream seam is never
        // re-invoked and no delta is re-emitted — yet the run returns the identical
        // final value (deltas are ephemeral; the persisted message is durable).
        deltas.length = 0;

        const replay = await runAgentLoop(loopDefaults(agent, { onTokenDelta, run: runtime.run, step: journal, streamGenerate: stream.seam }));

        expect(replay).toStrictEqual(first);
        expect(deltas).toStrictEqual([]);
        expect(stream.state.calls).toBe(1);
        expect(journal.invoked.filter((name) => name === "llm:turn:0")).toHaveLength(1);
    });

    it("takes the byte-identical non-streaming path when no token sink is present", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });

        // Baseline: the existing non-streaming path with no streaming wiring at all.
        const baseRuntime = memoryRuntime();
        const baseResult = await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("hi there")]), run: baseRuntime.run }));

        // A streaming seam is wired, but WITHOUT a sink the loop must ignore it and
        // run the identical `generate` path.
        const runtime = memoryRuntime();
        const stream = scriptedStreamGenerate([{ deltas: ["should not stream"], result: finalTurn("should not stream") }]);
        const result = await runAgentLoop(
            loopDefaults(agent, { generate: scriptedGenerate([finalTurn("hi there")]), run: runtime.run, streamGenerate: stream.seam }),
        );

        expect(stream.state.calls).toBe(0);
        expect(result).toStrictEqual(baseResult);

        const project = (rt: ReturnType<typeof memoryRuntime>): unknown[] =>
            [...rt.messages.values()].toSorted((a, b) => a.seq - b.seq).map((message) => [message.seq, message.role, message.content]);

        expect(project(runtime)).toStrictEqual(project(baseRuntime));
    });

    it("ignores a token sink when no streaming seam is wired (falls back to generate)", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();

        const deltas: AgentTokenDelta[] = [];
        const onTokenDelta: AgentTokenSink = (delta) => {
            deltas.push(delta);
        };

        // A sink is present, but with no `streamGenerate` the gate stays closed.
        const result = await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("plain")]), onTokenDelta, run: runtime.run }));

        expect(result).toStrictEqual({ stopped: "final", text: "plain", turns: 1 });
        expect(deltas).toStrictEqual([]);
    });
});
