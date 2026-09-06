import type { Telemetry } from "ai";
import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../../src/agent-loop";
import { defineAgent, defineAgentTool } from "../../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../../src/paths";
import { otlpTelemetry } from "../../src/telemetry/otlp";
import { traceToolExecution } from "../../src/telemetry/tool-execution";
import type { AgentGenerate, AgentGenerateResult } from "../../src/types";
import { DurableStepJournal, memoryRuntime } from "../loop-harness";

/**
 * Tool spans have to come from the LOOP, and only a loop-driven test can prove it.
 *
 * Lunora exposes each tool to the model schema-only (no `execute`), because
 * execution belongs in the durable step. `ai@7` skips its entire tool-telemetry
 * path for a tool it cannot execute, so `executeTool` on every bridge was
 * unreachable code while the suites — which invoked the hook by hand — stayed
 * green.
 */

/** Names of the OTLP spans captured from the POST bodies, in order. */
const captureSpanNames = (): string[] => {
    const names: string[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };

            for (const resource of body.resourceSpans) {
                for (const scope of resource.scopeSpans) {
                    for (const span of scope.spans) {
                        names.push(span.name);
                    }
                }
            }

            return Promise.resolve(new Response(null, { status: 200 }));
        }),
    );

    return names;
};

/** A scripted LLM seam: one tool-calling turn, then a final answer. */
const scriptedGenerate = (turns: AgentGenerateResult[]): AgentGenerate => {
    const remaining = [...turns];

    return async () => {
        const next = remaining.shift();

        if (!next) {
            throw new Error("scripted generate exhausted");
        }

        return next;
    };
};

describe("agent-loop tool telemetry", () => {
    it("emits an execute_tool span from the durable step that actually runs the tool", async () => {
        const names = captureSpanNames();
        let toolRuns = 0;

        const agent = defineAgent({
            instructions: "You are a weather agent.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            telemetry: { integrations: [otlpTelemetry({ endpoint: "https://collector.test" })], isEnabled: true },
            tools: {
                getWeather: defineAgentTool({
                    description: "Look up the weather.",
                    execute: (input: { city: string }) => {
                        toolRuns += 1;

                        return `sunny in ${input.city}`;
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const journal = new DurableStepJournal();

        await runAgentLoop({
            agent,
            env: { LUNORA_TEST: true },
            exportName: "weather",
            generate: scriptedGenerate([
                { text: "checking…", toolCalls: [{ id: "call_1", input: { city: "Berlin" }, name: "getWeather" }] },
                { text: "It is sunny in Berlin.", toolCalls: [] },
            ]),
            instanceId: "wf-1",
            params: { input: "hello", threadKey: "thread-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run: memoryRuntime().run,
            step: journal,
        });

        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        expect(toolRuns).toBe(1);
        expect(names).toStrictEqual(["execute_tool getWeather"]);

        vi.unstubAllGlobals();
    });

    it("does not re-emit a tool span for a memoized (replayed) step", async () => {
        const journal = new DurableStepJournal();

        const build = (names: string[]) =>
            defineAgent({
                instructions: "You are a weather agent.",
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                telemetry: { integrations: [otlpTelemetry({ endpoint: "https://collector.test" })], isEnabled: true },
                tools: {
                    getWeather: defineAgentTool({
                        description: "Look up the weather.",
                        execute: () => {
                            names.push("ran");

                            return "sunny";
                        },
                        inputSchema: { jsonSchema: { type: "object" } } as never,
                    }),
                },
            });

        const runOnce = async (): Promise<string[]> => {
            const names = captureSpanNames();
            const runtime = memoryRuntime();

            await runAgentLoop({
                agent: build([]),
                env: { LUNORA_TEST: true },
                exportName: "weather",
                generate: scriptedGenerate([
                    { text: "checking…", toolCalls: [{ id: "call_1", input: { city: "Berlin" }, name: "getWeather" }] },
                    { text: "done", toolCalls: [] },
                ]),
                instanceId: "wf-1",
                params: { input: "hello", threadKey: "thread-1" },
                paths: DEFAULT_AGENT_FUNCTION_PATHS,
                run: runtime.run,
                step: journal,
            });

            await new Promise((resolve) => {
                setTimeout(resolve, 20);
            });

            vi.unstubAllGlobals();

            return names;
        };

        await expect(runOnce()).resolves.toStrictEqual(["execute_tool getWeather"]);
        // The journal replays the memoized step, so the tool never runs again —
        // and neither does its span. One span per REAL execution.
        await expect(runOnce()).resolves.toStrictEqual([]);
    });

    it.each([
        ["before the tool runs", true],
        ["after the tool ran", false],
    ])("survives a telemetry integration whose executeTool throws %s", async (_label, throwFirst) => {
        let toolRuns = 0;

        // A host SDK throwing inside `executeTool` runs INSIDE the tool's durable
        // `step.do`. Left unguarded it becomes the TOOL's failure: the step retries
        // a tool that already ran, or reports a successful one as failed. The
        // integration is flow control for nothing.
        const throwing: Telemetry = {
            executeTool: async (options_) => {
                if (throwFirst) {
                    throw new Error("sentry is down");
                }

                await options_.execute();

                throw new Error("span.end() blew up");
            },
        };

        const agent = defineAgent({
            instructions: "You are a weather agent.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            telemetry: { integrations: [throwing], isEnabled: true },
            tools: {
                getWeather: defineAgentTool({
                    description: "Look up the weather.",
                    execute: (input: { city: string }) => {
                        toolRuns += 1;

                        return `sunny in ${input.city}`;
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const result = await runAgentLoop({
            agent,
            env: { LUNORA_TEST: true },
            exportName: "weather",
            generate: scriptedGenerate([
                { text: "checking…", toolCalls: [{ id: "call_1", input: { city: "Berlin" }, name: "getWeather" }] },
                { text: "It is sunny in Berlin.", toolCalls: [] },
            ]),
            instanceId: "wf-1",
            params: { input: "hello", threadKey: "thread-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run: memoryRuntime().run,
            step: new DurableStepJournal(),
        });

        // Exactly once either way: never skipped, never retried.
        expect(toolRuns).toBe(1);
        expect(result.text).toBe("It is sunny in Berlin.");
    });
});

/**
 * The ai@7 contract hands `executeTool` the tool's `execute` and then trusts the
 * wrapper's returned promise. These pin that the DURABLE outcome never depends on
 * that trust: the wrapper is host SDK code running inside the tool's `step.do`,
 * so letting it decide would mean telemetry skipping a tool, replacing its
 * result, or retrying one that already succeeded.
 */
describe("traceToolExecution — the wrapper cannot decide the tool's outcome", () => {
    const call = { id: "call-1", input: { city: "Berlin" }, name: "getWeather" };
    const telemetryWith = (executeTool: Telemetry["executeTool"]): never => ({ integrations: [{ executeTool }] }) as never;

    it("runs the tool anyway when the wrapper never calls execute", async () => {
        expect.assertions(2);

        const execute = vi.fn<() => Promise<string>>(() => Promise.resolve("real"));
        // A wrapper that returns without ever invoking `execute`.
        const output = await traceToolExecution(telemetryWith((() => Promise.resolve("fabricated")) as never), call, execute);

        expect(execute).toHaveBeenCalledTimes(1);
        expect(output).toBe("real");
    });

    it("returns the tool's value, not a replacement the wrapper substituted", async () => {
        expect.assertions(2);

        const execute = vi.fn<() => Promise<string>>(() => Promise.resolve("real"));
        const output = await traceToolExecution(
            telemetryWith((async (options: { execute: () => Promise<unknown> }) => {
                await options.execute();

                return "substituted";
            }) as never),
            call,
            execute,
        );

        expect(execute).toHaveBeenCalledTimes(1);
        expect(output).toBe("real");
    });

    it("keeps a successful tool successful when the wrapper rejects after it ran", async () => {
        expect.assertions(2);

        const execute = vi.fn<() => Promise<string>>(() => Promise.resolve("real"));
        const output = await traceToolExecution(
            telemetryWith((async (options: { execute: () => Promise<unknown> }) => {
                await options.execute();

                // Ending a span, flushing — a fault around a success.
                throw new Error("telemetry is down");
            }) as never),
            call,
            execute,
        );

        expect(execute).toHaveBeenCalledTimes(1);
        expect(output).toBe("real");
    });

    it("executes the tool exactly once when the wrapper starts it without awaiting", async () => {
        expect.assertions(2);

        const execute = vi.fn<() => Promise<string>>(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });

            return "real";
        });
        const output = await traceToolExecution(
            telemetryWith(((options: { execute: () => Promise<unknown> }) => {
                // Started, deliberately not awaited — the memoized promise is what
                // keeps this from running the tool a second time.
                options.execute().catch(() => undefined);

                return Promise.resolve("ignored");
            }) as never),
            call,
            execute,
        );

        expect(execute).toHaveBeenCalledTimes(1);
        expect(output).toBe("real");
    });

    it("rethrows the tool's own failure, not the wrapper's", async () => {
        expect.assertions(1);

        const execute = vi.fn<() => Promise<string>>(() => Promise.reject(new Error("tool blew up")));

        await expect(
            traceToolExecution(
                telemetryWith((async (options: { execute: () => Promise<unknown> }) => {
                    try {
                        await options.execute();
                    } catch {
                        throw new Error("wrapper noticed and threw its own");
                    }
                }) as never),
                call,
                execute,
            ),
        ).rejects.toThrow("tool blew up");
    });
});
