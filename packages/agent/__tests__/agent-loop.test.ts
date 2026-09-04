import { createDispatchRunner } from "@lunora/dispatch";
import { hasToolCall, jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { createAgentGenerate } from "../src/generate";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type {
    AgentCompact,
    AgentDefinition,
    AgentEpisodeExtract,
    AgentGenerate,
    AgentGenerateResult,
    AgentGraphExtract,
    AgentLiveEvent,
    AgentRunFunction,
    AgentStepFinishInfo,
    AgentStreamGenerate,
    AgentTokenDelta,
    AgentTokenSink,
    AgentToolContext,
} from "../src/types";
import { memoryRuntime } from "./loop-harness";

const IN_FLIGHT_PATTERN = /already has a run in flight/u;
const TRANSIENT_WAIT_FAILURE_PATTERN = /temporarily unavailable/u;

/**
 * A token sink that captures only token deltas, narrowing off the ephemeral
 * progress arm (exercised by the reportProgress test) so `deltas` stays
 * token-typed.
 */
const captureTokenDeltas =
    (deltas: AgentTokenDelta[]): AgentTokenSink =>
    (event) => {
        if (event.kind !== "progress") {
            deltas.push(event);
        }
    };

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

    /** The options each entered wait was given (name → options), for asserting timeouts. */
    public readonly resolvedWaitOptions = new Map<string, { timeout?: number | string; type: string }>();

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
        this.resolvedWaitOptions.set(name, options);

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

/**
 * In-memory double of the agent runtime functions (`agents:*`), dispatched by
 * `__lunoraRef` exactly like the real `/_lunora/scheduler/dispatch` runner —
 * with the same idempotency semantics the component's mutations implement
 * (keyed appends, get-or-create threads, counter-allocated seq).
 */
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

    it("agentic memory mints a searchMemory tool instead of injecting context", async () => {
        const searchResult = {
            chunks: [
                { chunkIndex: 0, id: "doc-1#0", importance: 1, score: 0.9, sourceId: "doc-1", text: "Lunora runs on Durable Objects." },
                { chunkIndex: 1, id: "doc-2#0", importance: 1, score: 0.7, sourceId: "doc-2", text: "Agents compile onto Workflows." },
            ],
            context: "[source:doc-1#0]\nLunora runs on Durable Objects.\n\n[source:doc-2#0]\nAgents compile onto Workflows.",
            sources: [{ id: "doc-1" }, { id: "doc-2" }],
        };
        const runtime = memoryRuntime({ memory: { path: "rag:searchDocs", result: searchResult } });
        const generate = scriptedGenerate([toolTurn("s1", "searchMemory", { query: "durable objects" }, "searching…"), finalTurn("answered")]);

        const agent = defineAgent({
            memory: { mode: "agentic", source: "rag:searchDocs", topK: 3 },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        });

        const journal = new DurableStepJournal();

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // No one-shot injection: no `memory:retrieve` step ran; the search tool step did.
        expect(journal.invoked).not.toContain("memory:retrieve");
        expect(journal.invoked).toContain("tool:searchMemory:s1");

        // The tool dispatched the source with the query + the source's configured topK.
        const memoryDispatch = runtime.dispatches.find((dispatch) => dispatch.path === "rag:searchDocs");

        expect(memoryDispatch?.args).toStrictEqual({ query: "durable objects", topK: 3 });

        // No "Relevant context" system message was injected on turn 0.
        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes("Relevant context"))).toBe(false);

        // The persisted tool message is the COMPACT projection — ranked hits + sources,
        // with the giant joined `.context` DROPPED.
        const toolMessage = [...runtime.messages.values()].find((message) => message.role === "tool" && message.toolName === "searchMemory");
        const parsed = JSON.parse(toolMessage?.content ?? "{}") as { results: unknown; sources: unknown };

        expect(parsed.results).toStrictEqual([
            { id: "doc-1#0", score: 0.9, snippet: "Lunora runs on Durable Objects.", sourceId: "doc-1" },
            { id: "doc-2#0", score: 0.7, snippet: "Agents compile onto Workflows.", sourceId: "doc-2" },
        ]);
        expect(parsed.sources).toStrictEqual([{ id: "doc-1" }, { id: "doc-2" }]);
        expect(toolMessage?.content.includes("[source:doc-1#0]")).toBe(false);
    });

    it("lets the model override topK per searchMemory call", async () => {
        const runtime = memoryRuntime({ memory: { path: "rag:searchDocs", result: { chunks: [], context: "", sources: [] } } });
        const generate = scriptedGenerate([toolTurn("s1", "searchMemory", { query: "x", topK: 10 }), finalTurn("done")]);

        const agent = defineAgent({
            memory: { mode: "agentic", source: "rag:searchDocs", topK: 3 },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        });

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        const dispatch = runtime.dispatches.find((entry) => entry.path === "rag:searchDocs");

        expect(dispatch?.args).toStrictEqual({ query: "x", topK: 10 });
    });

    it("multi-hop: the model searches memory twice with distinct queries", async () => {
        const perQuery = (args?: Record<string, unknown>): unknown => {
            const query = args?.["query"] as string;

            return { chunks: [{ id: `hit:${query}`, score: 1, sourceId: "s", text: `about ${query}` }], context: "ignored", sources: [] };
        };
        const runtime = memoryRuntime({ memory: { path: "rag:searchDocs", result: perQuery } });
        const generate = scriptedGenerate([
            toolTurn("s1", "searchMemory", { query: "first" }),
            toolTurn("s2", "searchMemory", { query: "second" }),
            finalTurn("done"),
        ]);

        const agent = defineAgent({ memory: { mode: "agentic", source: "rag:searchDocs" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // Two distinct memoized search steps (no topK configured or passed → query only).
        expect(journal.invoked.filter((name) => name.startsWith("tool:searchMemory:"))).toStrictEqual(["tool:searchMemory:s1", "tool:searchMemory:s2"]);

        const searchDispatches = runtime.dispatches.filter((dispatch) => dispatch.path === "rag:searchDocs");

        expect(searchDispatches.map((dispatch) => dispatch.args)).toStrictEqual([{ query: "first" }, { query: "second" }]);
    });

    it("serves a completed searchMemory step from the journal across a crash + resume", async () => {
        let searchCalls = 0;
        const runtime = memoryRuntime({
            memory: {
                path: "rag:searchDocs",
                result: (): unknown => {
                    searchCalls += 1;

                    return { chunks: [{ id: "doc-1#0", score: 1, sourceId: "doc-1", text: "hit" }], context: "ignored", sources: [] };
                },
            },
        });
        const journal = new DurableStepJournal();
        const agent = defineAgent({ memory: { mode: "agentic", source: "rag:searchDocs" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });

        // First attempt: the search tool completes, then the process dies before the next turn.
        const crashing = scriptedGenerate([toolTurn("s1", "searchMemory", { query: "x" })]);

        await expect(runAgentLoop(loopDefaults(agent, { generate: crashing, run: runtime.run, step: journal }))).rejects.toThrow("scripted generate exhausted");
        expect(searchCalls).toBe(1);

        // Resume on the same journal: the completed search step is served from the memo — NOT re-run.
        const resumed = scriptedGenerate([finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate: resumed, run: runtime.run, step: journal }));

        expect(searchCalls).toBe(1);
        expect(journal.invoked.filter((name) => name === "tool:searchMemory:s1")).toHaveLength(1);
    });

    it("mints a readMemory tool when the agentic source sets `read`", async () => {
        const runtime = memoryRuntime({
            handlers: { "rag:getDoc": (args): unknown => `full text for ${args?.["id"] as string}` },
            memory: { path: "rag:searchDocs", result: { chunks: [], context: "", sources: [] } },
        });
        const generate = scriptedGenerate([toolTurn("r1", "readMemory", { id: "doc-1#0" }), finalTurn("done")]);

        const agent = defineAgent({
            memory: { mode: "agentic", read: "rag:getDoc", source: "rag:searchDocs" },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        });

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        const readDispatch = runtime.dispatches.find((dispatch) => dispatch.path === "rag:getDoc");

        expect(readDispatch?.args).toStrictEqual({ id: "doc-1#0" });

        const toolMessage = [...runtime.messages.values()].find((message) => message.role === "tool" && message.toolName === "readMemory");

        expect(toolMessage?.content).toBe("full text for doc-1#0");
    });

    it("graph memory traverses the owner graph and injects the triples as context", async () => {
        const triples = "- alice —[works_at]→ acme";
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse]: (): unknown => {
                    return { context: triples };
                },
            },
        });
        const generate = scriptedGenerate([finalTurn("answered")]);

        const agent = defineAgent({
            memory: { graph: { depth: 3, maxSeeds: 2 }, kind: "graph" },
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        });

        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, { generate, params: { input: "who works at acme?", owner: "user-a", threadKey: "thread-1" }, run: runtime.run, step: journal }),
        );

        // The graph read is a `memory:traverse` step (its own namespace), not `memory:retrieve`.
        expect(journal.invoked).toContain("memory:traverse");
        expect(journal.invoked).not.toContain("memory:retrieve");

        // It dispatched the built-in traverse function with the owner, query, and configured bounds only.
        const traverse = runtime.dispatches.find((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse);

        expect(traverse?.args).toStrictEqual({ depth: 3, maxSeeds: 2, owner: "user-a", query: "who works at acme?" });

        // The triples reached the model as a system message.
        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes(triples))).toBe(true);
    });

    it("graph memory no-ops for an anonymous run (no owner)", async () => {
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse]: (): unknown => {
                    return { context: "should not run" };
                },
            },
        });
        const generate = scriptedGenerate([finalTurn("answered")]);

        const agent = defineAgent({ memory: { kind: "graph" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        // No `owner` on params → the owner-scoped graph has nothing to read.
        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(journal.invoked).not.toContain("memory:traverse");
        expect(runtime.dispatches.some((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse)).toBe(false);
    });

    it("extracts a graph at run end and upserts it, keyed by owner + instance", async () => {
        const extraction = { entities: [{ name: "Alice", type: "person" }], relations: [{ dst: "Acme", label: "works_at", src: "Alice" }] };
        let extractCalls = 0;
        const extractGraph: AgentGraphExtract = async ({ assistantText, userInput }) => {
            extractCalls += 1;

            // The seam sees the run's exchange (user input + final answer).
            expect(userInput).toBe("tell me about alice");
            expect(assistantText).toBe("Alice works at Acme.");

            return extraction;
        };
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse]: (): unknown => {
                    return { context: "" };
                },
                [DEFAULT_AGENT_FUNCTION_PATHS.graphUpsert]: (): unknown => {
                    return { entities: 1, relations: 1 };
                },
            },
        });
        const generate = scriptedGenerate([finalTurn("Alice works at Acme.")]);

        const agent = defineAgent({ memory: { kind: "graph" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, {
                extractGraph,
                generate,
                params: { input: "tell me about alice", owner: "user-a", threadKey: "thread-1" },
                run: runtime.run,
                step: journal,
            }),
        );

        expect(extractCalls).toBe(1);
        expect(journal.invoked).toContain("memory:extract");

        const upsert = runtime.dispatches.find((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.graphUpsert);

        expect(upsert?.args).toStrictEqual({ ...extraction, messageKey: "wf-1:extract", owner: "user-a" });
    });

    it("never re-extracts the graph across a crash + resume", async () => {
        let extractCalls = 0;
        const extractGraph: AgentGraphExtract = async () => {
            extractCalls += 1;

            return { entities: [{ name: "Alice" }], relations: [] };
        };
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.graphTraverse]: (): unknown => {
                    return { context: "" };
                },
                [DEFAULT_AGENT_FUNCTION_PATHS.graphUpsert]: (): unknown => {
                    return { entities: 1, relations: 0 };
                },
            },
        });
        const agent = defineAgent({ memory: { kind: "graph" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();
        const params = { input: "hi", owner: "user-a", threadKey: "thread-1" };

        // First attempt crashes AFTER the final turn + extraction, on the run-completion dispatch.
        let failPatch = true;
        const crashingRun: AgentRunFunction = async (reference, args) => {
            if (failPatch && reference["__lunoraRef"] === DEFAULT_AGENT_FUNCTION_PATHS.completeRun && args?.["status"] === "idle") {
                failPatch = false;
                throw new Error("crash after extract");
            }

            return runtime.run(reference, args);
        };

        await expect(
            runAgentLoop(loopDefaults(agent, { extractGraph, generate: scriptedGenerate([finalTurn("done")]), params, run: crashingRun, step: journal })),
        ).rejects.toThrow("crash after extract");
        expect(extractCalls).toBe(1);

        // Resume on the same journal: the completed `memory:extract` step is served from the memo — NOT re-run.
        await runAgentLoop(loopDefaults(agent, { extractGraph, generate: scriptedGenerate([finalTurn("done")]), params, run: runtime.run, step: journal }));

        expect(extractCalls).toBe(1);
        expect(journal.invoked.filter((name) => name === "memory:extract")).toHaveLength(1);
    });

    it("does not extract for a semantic-only agent even when the seam is wired", async () => {
        let extractCalls = 0;
        const extractGraph: AgentGraphExtract = async () => {
            extractCalls += 1;

            return { entities: [], relations: [] };
        };
        const runtime = memoryRuntime({ memory: { path: "rag:searchDocs", result: { chunks: [], context: "ctx", sources: [] } } });
        const agent = defineAgent({ memory: { source: "rag:searchDocs" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, {
                extractGraph,
                generate: scriptedGenerate([finalTurn("done")]),
                params: { input: "hi", owner: "user-a", threadKey: "thread-1" },
                run: runtime.run,
                step: journal,
            }),
        );

        expect(extractCalls).toBe(0);
        expect(journal.invoked).not.toContain("memory:extract");
    });

    it("episodic memory recalls the owner timeline and injects it as context", async () => {
        const timeline = "- fixed the login bug";
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall]: (): unknown => {
                    return { context: timeline };
                },
            },
        });
        const generate = scriptedGenerate([finalTurn("answered")]);
        const agent = defineAgent({ memory: { episodic: { recall: 3 }, kind: "episodic" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, { generate, params: { input: "what next?", owner: "user-a", threadKey: "thread-1" }, run: runtime.run, step: journal }),
        );

        // The read is a `memory:recall` step (its own namespace), dispatching with owner + limit.
        expect(journal.invoked).toContain("memory:recall");

        const recall = runtime.dispatches.find((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall);

        expect(recall?.args).toStrictEqual({ limit: 3, owner: "user-a" });

        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes(timeline))).toBe(true);
    });

    it("episodic memory no-ops for an anonymous run (no owner)", async () => {
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall]: (): unknown => {
                    return { context: "should not run" };
                },
            },
        });
        const agent = defineAgent({ memory: { kind: "episodic" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("hi")]), run: runtime.run, step: journal }));

        expect(journal.invoked).not.toContain("memory:recall");
        expect(runtime.dispatches.some((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall)).toBe(false);
    });

    it("records an episode at run end via a memory:episode step, keyed by owner + instance", async () => {
        let extractCalls = 0;
        const extractEpisode: AgentEpisodeExtract = async ({ assistantText, userInput }) => {
            extractCalls += 1;

            expect(userInput).toBe("tell me about the outage");
            expect(assistantText).toBe("The outage was DNS.");

            return { summary: "diagnosed the DNS outage" };
        };
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall]: (): unknown => {
                    return { context: "" };
                },
                [DEFAULT_AGENT_FUNCTION_PATHS.episodeUpsert]: (): unknown => {
                    return { recorded: true };
                },
            },
        });
        const agent = defineAgent({ memory: { kind: "episodic" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, {
                extractEpisode,
                generate: scriptedGenerate([finalTurn("The outage was DNS.")]),
                params: { input: "tell me about the outage", owner: "user-a", threadKey: "thread-1" },
                run: runtime.run,
                step: journal,
            }),
        );

        expect(extractCalls).toBe(1);
        expect(journal.invoked).toContain("memory:episode");

        const upsert = runtime.dispatches.find((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.episodeUpsert);

        expect(upsert?.args).toStrictEqual({ messageKey: "wf-1:episode", owner: "user-a", summary: "diagnosed the DNS outage", threadKey: "thread-1" });
    });

    it("swallows a thrown episode extraction (best-effort — the answer is already persisted)", async () => {
        const extractEpisode: AgentEpisodeExtract = async () => {
            throw new Error("extraction boom");
        };
        const runtime = memoryRuntime({
            handlers: {
                [DEFAULT_AGENT_FUNCTION_PATHS.episodeRecall]: (): unknown => {
                    return { context: "" };
                },
            },
        });
        const agent = defineAgent({ memory: { kind: "episodic" }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        // The run completes despite the extraction throwing.
        const result = await runAgentLoop(
            loopDefaults(agent, {
                extractEpisode,
                generate: scriptedGenerate([finalTurn("done")]),
                params: { input: "hi", owner: "user-a", threadKey: "thread-1" },
                run: runtime.run,
                step: journal,
            }),
        );

        expect(result.text).toBe("done");
        expect(runtime.dispatches.some((dispatch) => dispatch.path === DEFAULT_AGENT_FUNCTION_PATHS.episodeUpsert)).toBe(false);
    });

    it("compaction summarizes older history and injects the brief into the turn", async () => {
        // A long thread history so compaction fires (maxMessages 2, keepRecent 1).
        const history = Array.from({ length: 6 }, (_, index) => {
            return { content: `m${String(index)}`, role: "user" as const, seq: index };
        });
        const runtime = memoryRuntime({ handlers: { [DEFAULT_AGENT_FUNCTION_PATHS.listMessages]: (): unknown => history } });
        let compactCalls = 0;
        const compact: AgentCompact = async () => {
            compactCalls += 1;

            return "earlier: the user asked several things";
        };
        const generate = scriptedGenerate([finalTurn("ok")]);
        const agent = defineAgent({ compaction: { keepRecent: 1, maxMessages: 2 }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        await runAgentLoop(
            loopDefaults(agent, { compact, generate, params: { input: "hi", owner: "user-a", threadKey: "thread-1" }, run: runtime.run, step: journal }),
        );

        expect(compactCalls).toBe(1);

        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.some((message) => message.role === "system" && String(message.content).includes("earlier: the user asked several things"))).toBe(true);
    });

    it("compaction falls back to the full history when the summarizer throws", async () => {
        const history = Array.from({ length: 6 }, (_, index) => {
            return { content: `m${String(index)}`, role: "user" as const, seq: index };
        });
        const runtime = memoryRuntime({ handlers: { [DEFAULT_AGENT_FUNCTION_PATHS.listMessages]: (): unknown => history } });
        const compact: AgentCompact = async () => {
            throw new Error("summarizer down");
        };
        const generate = scriptedGenerate([finalTurn("ok")]);
        const agent = defineAgent({ compaction: { keepRecent: 1, maxMessages: 2 }, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const journal = new DurableStepJournal();

        const result = await runAgentLoop(
            loopDefaults(agent, { compact, generate, params: { input: "hi", owner: "user-a", threadKey: "thread-1" }, run: runtime.run, step: journal }),
        );

        // The run still completes; the full (uncompacted) history reached the model.
        expect(result.text).toBe("ok");

        const shown = generate.seen[0] as { content: unknown; role: string }[];

        expect(shown.filter((message) => message.role === "user")).toHaveLength(6);
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

    it("times out a never-answered approval as a rejection instead of hibernating forever", async () => {
        let toolRuns = 0;

        const agent = defineAgent({
            approvalTimeout: "1 hour",
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
        // A step whose approval wait's timeout elapses: the host rejects the
        // `waitForEvent` promise (durable `do` steps delegate to the journal).
        const waitOptions: { timeout?: number | string; type: string }[] = [];
        const step = {
            do: async <T>(name: string, callback: () => Promise<T>): Promise<T> => journal.do(name, callback),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
            waitForEvent: async <T>(name: string, options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> => {
                if (name.startsWith("approval:")) {
                    waitOptions.push(options);

                    // The host's real elapsed-wait signal: an Error NAMED
                    // `WorkflowTimeoutError` (Cloudflare's workflows-shared).
                    const timeoutError = new Error("Execution timed out after 3600000ms");

                    timeoutError.name = "WorkflowTimeoutError";
                    throw timeoutError;
                }

                return journal.waitForEvent<T>(name, options);
            },
        };
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("could not charge")]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step }));

        // The run ENDED (no eternal hibernation) down the normal rejection path.
        expect(result).toStrictEqual({ stopped: "final", text: "could not charge", turns: 2 });
        expect(toolRuns).toBe(0);
        expect(journal.invoked).not.toContain("tool:charge:call_1");

        // The wait carried the agent's configured timeout, resolved to ms.
        expect(waitOptions).toStrictEqual([{ timeout: 3_600_000, type: "agent-approval:call_1" }]);

        // A terminal rejected record explains why, and the thread is released.
        const rejected = [...runtime.messages.values()].find((message) => message.status === "rejected");

        expect(rejected?.toolCallId).toBe("call_1");
        expect(rejected?.content).toContain("approval timed out");
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");

        // The pending-approval MARKER must be gone: every client derives its
        // Approve/Reject affordance from that row alone, so leaving it behind
        // keeps offering a decision that can no longer be delivered (the
        // instance it would resolve has finished).
        expect(runtime.messages.has("thread-1:wf-1:approval:call_1")).toBe(false);
    });

    it("clears the pending-approval marker once a human decision lands", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        journal.events.set("approval:call_1", { decision: "approve" });

        const generate = scriptedGenerate([toolTurn("call_1", "charge", {}, ""), finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // Not timeout-specific: an approved (or rejected) call stranded the same
        // marker, and the clients could not tell it was spent.
        expect(runtime.messages.has("thread-1:wf-1:approval:call_1")).toBe(false);

        // The real outcome still lands, on the tool-result row.
        const result = [...runtime.messages.values()].find((message) => message.toolCallId === "call_1");

        expect(result?.status).toBe("approved");
        expect(result?.content).toBe("charged");
    });

    it("defaults the approval wait timeout to 3 days when the agent sets none", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        // Deliver the decision up front so the run completes; the journal records the wait's options.
        journal.events.set("approval:call_1", { decision: "approve" });
        const generate = scriptedGenerate([toolTurn("call_1", "charge", {}, ""), finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(journal.resolvedWaitOptions.get("approval:call_1")?.timeout).toBe(3 * 24 * 60 * 60 * 1000);
    });

    it("propagates a NON-timeout wait failure instead of recording it as a human rejection", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        // A host/binding failure — NOT an elapsed timeout. Recording this as
        // "rejected by the user" would durably assert that a human declined the
        // charge when nobody was ever asked, so it must surface as a failed run.
        const step = {
            do: async <T>(name: string, callback: () => Promise<T>): Promise<T> => journal.do(name, callback),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
            waitForEvent: async <T>(name: string, options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> => {
                if (name.startsWith("approval:")) {
                    throw new Error("workflows service temporarily unavailable");
                }

                return journal.waitForEvent<T>(name, options);
            },
        };
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("done")]);

        await expect(runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step }))).rejects.toThrow(TRANSIENT_WAIT_FAILURE_PATTERN);

        // No decision was invented: nothing was recorded as rejected/approved.
        expect([...runtime.messages.values()].some((message) => message.status === "rejected")).toBe(false);
        expect([...runtime.messages.values()].some((message) => message.status === "approved")).toBe(false);
    });

    it("clamps a configured approval timeout to one week so it cannot outlive the thread's reclaim horizon", async () => {
        const agent = defineAgent({
            // 30 days would let the reclaim take the thread while the approval is
            // still pending — reconstructing the stranding bug the timeout prevents.
            approvalTimeout: "30 days",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: true,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        journal.events.set("approval:call_1", { decision: "approve" });

        const generate = scriptedGenerate([toolTurn("call_1", "charge", {}, ""), finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        // Clamped to APPROVAL_TIMEOUT_MAX_MS — half of the 14-day horizon the
        // reclaim derives from it, so the wait always fires first.
        expect(journal.resolvedWaitOptions.get("approval:call_1")?.timeout).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("memoizes a function needsApproval gate in its own durable step — it resolves once, not once per replay", async () => {
        let gateCalls = 0;

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: () => {
                        gateCalls += 1;

                        return false;
                    },
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("done")]);

        const first = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(first).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(gateCalls).toBe(1);

        // Replay: SAME journal + runtime (same instance) — every durable step,
        // including the gate, is served from its memo. Nothing re-executes.
        const replay = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(replay).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(gateCalls).toBe(1);
        expect(journal.invoked.filter((name) => name === "tool:approval-gate:call_1")).toHaveLength(1);
    });

    it("does not hang on a replayed false→true gate flip — the memoized decision wins, no approval wait entered", async () => {
        let flip = false;

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: () => flip,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("done")]);

        const first = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(first).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");

        // The world changes after the original pass — a naive re-evaluation on
        // replay would now gate `true` and park the run on a wait no client will
        // ever resolve. The memoized `false` must win instead.
        flip = true;

        const replay = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(replay).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(journal.waitedNames).toStrictEqual([]);
        expect([...runtime.messages.values()].some((message) => message.status === "awaiting_approval")).toBe(false);
    });

    it("hands the function gate a read-only context with no setState", async () => {
        let sawSetState: boolean | undefined;

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: () => "charged",
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: (_input, context) => {
                        sawSetState = "setState" in context;

                        return false;
                    },
                }),
            },
        });

        const runtime = memoryRuntime();
        const generate = scriptedGenerate([toolTurn("call_1", "charge", { amount: 100 }, "charging…"), finalTurn("done")]);

        await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run }));

        expect(sawSetState).toBe(false);
    });

    it("keys the gate's durable step per call id — two calls in one turn each memoize independently", async () => {
        const gateCallCounts: Record<string, number> = {};

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                charge: defineAgentTool({
                    description: "Charge the card.",
                    execute: (input: { amount: number }) => `charged ${String(input.amount)}`,
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                    needsApproval: (_input, context) => {
                        gateCallCounts[context.toolCallId] = (gateCallCounts[context.toolCallId] ?? 0) + 1;

                        return false;
                    },
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();
        const generate = scriptedGenerate([
            {
                text: "charging both…",
                toolCalls: [
                    { id: "call_1", input: { amount: 10 }, name: "charge" },
                    { id: "call_2", input: { amount: 20 }, name: "charge" },
                ],
            },
            finalTurn("done"),
        ]);

        const first = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(first).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(gateCallCounts).toStrictEqual({ call_1: 1, call_2: 1 });
        expect(journal.invoked).toContain("tool:approval-gate:call_1");
        expect(journal.invoked).toContain("tool:approval-gate:call_2");

        // Replay: both calls' gate decisions are memoized independently.
        const replay = await runAgentLoop(loopDefaults(agent, { generate, run: runtime.run, step: journal }));

        expect(replay).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect(gateCallCounts).toStrictEqual({ call_1: 1, call_2: 1 });
    });

    it("streams token deltas in order and persists the concatenated final text", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();

        const deltas: AgentTokenDelta[] = [];
        const onTokenDelta = captureTokenDeltas(deltas);
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
        const onTokenDelta = captureTokenDeltas(deltas);
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
        const onTokenDelta = captureTokenDeltas(deltas);

        // A sink is present, but with no `streamGenerate` the gate stays closed.
        const result = await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([finalTurn("plain")]), onTokenDelta, run: runtime.run }));

        expect(result).toStrictEqual({ stopped: "final", text: "plain", turns: 1 });
        expect(deltas).toStrictEqual([]);
    });

    it("tees ephemeral tool progress on the live sink, keyed by toolCallId, and never on replay", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                sync: defineAgentTool({
                    description: "A long-running tool that reports progress.",
                    execute: (_input: unknown, context) => {
                        context.reportProgress({ pct: 50 });
                        context.reportProgress({ pct: 100 });

                        return "synced";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        // The progress arm rides the SAME sink as token deltas.
        const events: AgentLiveEvent[] = [];
        const onTokenDelta: AgentTokenSink = (event) => {
            events.push(event);
        };

        // Non-streaming `generate`: progress is independent of token streaming.
        const generate = scriptedGenerate([toolTurn("call_p", "sync", {}, "working…"), finalTurn("all synced")]);

        const first = await runAgentLoop(loopDefaults(agent, { generate, onTokenDelta, run: runtime.run, step: journal }));

        expect(first).toStrictEqual({ stopped: "final", text: "all synced", turns: 2 });

        // Only progress events (no token deltas on the non-streaming path), each
        // keyed to the tool call that emitted it — in emit order.
        expect(events).toStrictEqual([
            { data: { pct: 50 }, kind: "progress", threadKey: "thread-1", toolCallId: "call_p" },
            { data: { pct: 100 }, kind: "progress", threadKey: "thread-1", toolCallId: "call_p" },
        ]);

        // Replay the SAME instance: the memoized `tool:sync:call_p` step is served
        // without re-running `execute`, so no progress is re-emitted (ephemeral,
        // live-only — consistent with token deltas). Reusing the exhausted `generate`
        // proves the turns are memoized too (a re-invocation would throw).
        events.length = 0;

        const replay = await runAgentLoop(loopDefaults(agent, { generate, onTokenDelta, run: runtime.run, step: journal }));

        expect(replay).toStrictEqual(first);
        expect(events).toStrictEqual([]);
    });
});

describe("a tool call whose input failed validation", () => {
    it("is recorded as a recoverable tool result and the tool is never run", async () => {
        const executed: unknown[] = [];
        // The AI SDK validates the model's arguments against the tool's own schema,
        // marks a failing call `invalid`, refuses to execute it itself — and still
        // lists it in `result.toolCalls`, with the RAW unvalidated input.
        const agent = defineAgent({
            maxTurns: 1,
            model: new MockLanguageModelV4({
                doGenerate: async () => {
                    return {
                        content: [{ input: JSON.stringify({ amount: "not-a-number" }), toolCallId: "call-1", toolName: "charge", type: "tool-call" as const }],
                        finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
                        usage: {
                            inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: undefined, total: 1 },
                            outputTokens: { reasoning: undefined, text: undefined, total: 1 },
                        },
                        warnings: [],
                    };
                },
            }),
            tools: {
                charge: defineAgentTool({
                    description: "charge a card",
                    execute: (input: unknown) => {
                        executed.push(input);

                        return "charged";
                    },
                    inputSchema: jsonSchema<{ amount: number }>(
                        { additionalProperties: false, properties: { amount: { type: "number" } }, required: ["amount"], type: "object" },
                        {
                            validate: (value) => {
                                if (typeof (value as { amount?: unknown }).amount === "number") {
                                    return { success: true, value: value as { amount: number } };
                                }

                                return { error: new Error("amount must be a number"), success: false };
                            },
                        },
                    ),
                }),
            },
        });
        const runtime = memoryRuntime();

        await runAgentLoop(loopDefaults(agent, { generate: createAgentGenerate(agent, {}), run: runtime.run }));

        expect(executed).toStrictEqual([]);

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool");

        expect(toolRow?.content).toContain('Error: invalid input for tool "charge" — it was not run.');
    });
});

describe("a tool whose dispatch failed deterministically", () => {
    it("is recorded as a recoverable tool result instead of burning the step's retries", async () => {
        expect.assertions(3);

        // Built the way production builds it — a real `{ error: { code, … } }`
        // envelope through the dispatch runner — so the error carries the brand
        // `isDeterministicDispatchFailure` keys on. A hand-rolled LunoraError
        // with the same status would not, and would stay retryable.
        const dispatchFailure = await createDispatchRunner({
            env: { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com/" },
            fetchImpl: async () => Response.json({ error: { code: "BAD_REQUEST", message: '"path" must be a string' } }, { status: 400 }),
            label: "@lunora/agent",
        })({ __lunoraRef: "sandbox:invoke" }).then(
            () => undefined,
            (error: unknown) => error,
        );

        let attempts = 0;
        const agent = defineAgent({
            maxTurns: 2,
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                fs: defineAgentTool({
                    description: "read a file",
                    // What a batteries-included `jsonSchema()` tool does with a
                    // type-wrong model argument: the action's own validator 400s.
                    execute: () => {
                        attempts += 1;

                        throw dispatchFailure;
                    },
                    // A bare `jsonSchema()`: no `validate`, so nothing upstream
                    // rejects `path: 5` and the call never arrives as `invalid`.
                    inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
                }),
            },
        });
        const runtime = memoryRuntime();

        const result = await runAgentLoop(
            loopDefaults(agent, {
                generate: scriptedGenerate([toolTurn("call-1", "fs", { op: "read", path: 5 }), finalTurn("path has to be a string — retrying")]),
                run: runtime.run,
            }),
        );

        expect(result).toStrictEqual({ stopped: "final", text: "path has to be a string — retrying", turns: 2 });
        expect(attempts).toBe(1);

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool");

        expect(toolRow?.content).toContain('"path" must be a string');
    });
});

describe("tool output size", () => {
    it("caps what is persisted, and therefore what every later turn re-injects", async () => {
        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                read: defineAgentTool({
                    description: "read a file",
                    // Well under `fsTool`'s 1 MB ceiling, and already 5x the cap.
                    execute: () => "x".repeat(20_000),
                    inputSchema: jsonSchema({ additionalProperties: true, type: "object" }),
                }),
            },
        });
        const runtime = memoryRuntime();

        await runAgentLoop(loopDefaults(agent, { generate: scriptedGenerate([toolTurn("call-1", "read", {}), finalTurn("done")]), run: runtime.run }));

        const toolRow = [...runtime.messages.values()].find((message) => message.role === "tool");

        // Exactly the cap, marker included: the marker is part of the persisted
        // row, so its length comes out of the budget rather than being added on
        // top of it.
        expect(toolRow?.content).toHaveLength(4000);
        expect(toolRow?.content.endsWith("… [truncated]")).toBe(true);
    });
});

describe("a failing run-completion dispatch", () => {
    it("propagates the ORIGINAL run failure, with the dispatch failure as its cause", async () => {
        const agent = defineAgent({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
        const runtime = memoryRuntime();
        const run: AgentRunFunction = async (reference, args) => {
            if (reference["__lunoraRef"] === DEFAULT_AGENT_FUNCTION_PATHS.completeRun) {
                throw new Error("completeRun dispatch failed");
            }

            return runtime.run(reference, args);
        };

        const error = (await runAgentLoop(
            loopDefaults(agent, {
                generate: () => {
                    throw new Error("the model provider is down");
                },
                run,
            }),
        ).catch((error_: unknown) => error_)) as Error;

        // The bookkeeping failure used to REPLACE the real cause in the instance record.
        expect(error.message).toBe("the model provider is down");
        expect((error.cause as Error).message).toBe("completeRun dispatch failed");
    });
});
