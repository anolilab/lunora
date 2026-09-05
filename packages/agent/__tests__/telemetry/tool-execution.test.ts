import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../../src/agent-loop";
import { defineAgent, defineAgentTool } from "../../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../../src/paths";
import { otlpTelemetry } from "../../src/telemetry/otlp";
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
});
