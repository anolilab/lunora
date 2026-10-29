/**
 * The loop dispatches at-least-once (no replay-dedup id) and stays correct
 * because every function it calls is idempotent on its own key. These two
 * suites pin both halves of that: a crash + resume driven through the
 * production dispatcher against a shard that models the real
 * `(identity, mutationId)` dedup table, and a re-application of every dispatch
 * the loop made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import resolveAgentRun from "../src/resolve-run";
import type { AgentDefinition, AgentRunFunction } from "../src/types";
import { DurableStepJournal, finalTurn, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

const DISPATCH_ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example" };

const chargingAgent = (): AgentDefinition =>
    defineAgent({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        tools: {
            charge: defineAgentTool({
                description: "Charge the card.",
                execute: () => "charged",
                inputSchema: { jsonSchema: { type: "object" } } as never,
            }),
        },
    });

describe("replay dedup", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("completes a crash + resume when the shard dedupes on the dispatched id", async () => {
        const runtime = memoryRuntime();
        const dedupIds: (string | undefined)[] = [];

        /**
         * The shard's replay-dedup table as `ShardDO` implements it: keyed
         * `(identity, mutationId)` with NO function path in the key, and a hit
         * short-circuits to the first call's cached result without running the
         * handler. Every dispatch here shares the one `"system:"` identity, so
         * one map is the whole namespace — which is exactly why an id reused
         * across two different calls returns the wrong one's answer.
         */
        const cached = new Map<string, unknown>();

        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init: RequestInit) => {
                const body = JSON.parse(init.body as string) as { args: Record<string, unknown>; functionPath: string; id?: string };

                dedupIds.push(body.id);

                if (body.id !== undefined && cached.has(body.id)) {
                    return Response.json({ result: cached.get(body.id) ?? null });
                }

                const result = await runtime.run({ __lunoraRef: body.functionPath }, body.args);

                if (body.id !== undefined) {
                    cached.set(body.id, result);
                }

                return Response.json({ result: result ?? null });
            }),
        );

        const agent = chargingAgent();
        const journal = new DurableStepJournal();
        // The production seam: what `compileAgentWorkflow` hands the loop, built
        // fresh per ACTIVATION exactly as the compiled handler builds it.
        const wiring = (): { env: typeof DISPATCH_ENV; run: AgentRunFunction; step: DurableStepJournal } => {
            return {
                env: DISPATCH_ENV,
                run: resolveAgentRun(undefined, DISPATCH_ENV),
                step: journal,
            };
        };

        // Attempt 1: the tool completes, then the next LLM turn dies.
        await expect(
            runAgentLoop(loopDefaults(agent, { ...wiring(), generate: scriptedGenerate([toolTurn("call_9", "charge", { amount: 100 })]) })),
        ).rejects.toThrow("scripted generate exhausted");

        // Resume: `llm:turn:0` and the tool step are served from the journal, so
        // this activation dispatches a DIFFERENT set of calls than the first. An
        // order-numbered dedup id would hand one of them an id the first
        // activation already spent — the history read would come back as an
        // append's `{ seq }`.
        const result = await runAgentLoop(loopDefaults(agent, { ...wiring(), generate: scriptedGenerate([finalTurn("done")]) }));

        expect(result).toStrictEqual({ stopped: "final", text: "done", turns: 2 });
        expect([...runtime.messages.values()].map((message) => message.role)).toStrictEqual(["user", "assistant", "tool", "assistant"]);
        expect(runtime.threads.get("thread-1")?.status).toBe("idle");
        expect(dedupIds.every((id) => id === undefined)).toBe(true);
    });

    it("keeps every dispatch the loop makes idempotent, so a redelivered one changes nothing", async () => {
        const runtime = memoryRuntime();
        const generate = scriptedGenerate([toolTurn("call_9", "charge", { amount: 100 }), finalTurn("done")]);

        await runAgentLoop(loopDefaults(chargingAgent(), { generate, run: runtime.run, step: new DurableStepJournal() }));

        const before = JSON.stringify([[...runtime.threads], [...runtime.messages]]);
        // Snapshot: `runtime.run` appends to `dispatches`, so iterating the live
        // array below would never terminate.
        const recorded = [...runtime.dispatches];

        // The loop carries no dispatch-level dedup id, so what keeps an
        // at-least-once redelivery harmless is that every function it calls is
        // idempotent by its own key (messageKey, instance ownership, absolute
        // patches). Re-apply the whole recorded sequence: nothing may move.
        for (const dispatch of recorded) {
            // eslint-disable-next-line no-await-in-loop -- replaying the recorded sequence in order is the point
            await runtime.run({ __lunoraRef: dispatch.path }, dispatch.args);
        }

        expect(JSON.stringify([[...runtime.threads], [...runtime.messages]])).toBe(before);
    });
});
