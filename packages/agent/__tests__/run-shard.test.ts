import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import createAgentContext from "../src/create-agent-context";
import { defineAgent } from "../src/define-agent";
import { functionTool } from "../src/function-tool";
import type { AgentRunFunction, AgentRunInput } from "../src/types";
import { DurableStepJournal, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

const inputSchema = jsonSchema<{ id: string }>({ properties: { id: { type: "string" } }, required: ["id"], type: "object" });

interface SeenCall {
    options: Parameters<AgentRunFunction>[2];
    ref: string;
}

/**
 * A run started from the `org-a` shard of a `.shardBy("organizationId")` app. The app's
 * `orders:byId` reads a sharded table, so it only finds the order on `org-a`; the agent's
 * own thread functions live on the default shard, where the client hooks subscribe.
 */
const runOnShard = async (shardKey: string | undefined): Promise<SeenCall[]> => {
    const runtime = memoryRuntime();
    const seen: SeenCall[] = [];
    const run: AgentRunFunction = async (reference, args, options) => {
        seen.push({ options, ref: reference["__lunoraRef"] });

        if (reference["__lunoraRef"] === "orders:byId") {
            return `order ${String(args?.["id"])}`;
        }

        return reference["__lunoraRef"] === "rag:searchDocs" ? { context: "policy" } : runtime.run(reference, args, options);
    };
    const agent = defineAgent({
        memory: { source: "rag:searchDocs" },
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        tools: { lookupOrder: functionTool("orders:byId", { description: "Look up an order by id.", inputSchema }) },
    });
    const params: AgentRunInput = { input: "where is o_42?", threadKey: "thread-1", ...(shardKey === undefined ? {} : { shardKey }) };

    await runAgentLoop(
        loopDefaults(agent, {
            generate: scriptedGenerate([toolTurn("call_1", "lookupOrder", { id: "o_42" }), { text: "Shipped.", toolCalls: [] }]),
            params,
            run,
            step: new DurableStepJournal(),
        }),
    );

    return seen;
};

describe("agent run shard", () => {
    it("dispatches a functionTool call and a memory source to the shard the run was started on", async () => {
        expect.assertions(3);

        const seen = await runOnShard("org-a");

        expect(seen.filter((call) => call.ref === "orders:byId").map((call) => call.options?.shardKey)).toStrictEqual(["org-a"]);
        expect(seen.filter((call) => call.ref === "rag:searchDocs").map((call) => call.options?.shardKey)).toStrictEqual(["org-a"]);
        // The loop's own thread reads and writes stay on the default shard.
        expect(seen.filter((call) => call.ref.startsWith("agents:")).every((call) => call.options?.shardKey === undefined)).toBe(true);
    });

    it("leaves every call on the default shard when the run carries no shard", async () => {
        expect.assertions(1);

        const seen = await runOnShard(undefined);

        expect(seen.every((call) => call.options?.shardKey === undefined)).toBe(true);
    });

    it("stamps the starting shard onto the run, over any shardKey in the input", async () => {
        expect.assertions(2);

        const created: unknown[] = [];
        const binding = {
            create: async (options: { params: unknown }) => {
                created.push(options.params);

                return { id: "wf-1" };
            },
            get: async () => {
                throw new Error("unused");
            },
        };
        const specs = [{ className: "SupportAgentWorkflow", exportName: "support" }];
        const onOrgA = createAgentContext({ SupportAgentWorkflow: binding }, specs, { shardKey: "org-a" });
        const onRoot = createAgentContext({ SupportAgentWorkflow: binding }, specs);

        // `agents:agentRun` hands a public client's input straight through, so a shard named
        // in it must not route the run's tools into another tenant.
        await onOrgA.support?.run({ input: "hi", shardKey: "org-b", threadKey: "t" });
        await onRoot.support?.run({ input: "hi", shardKey: "org-b", threadKey: "t" });

        expect(created[0]).toStrictEqual({ input: "hi", shardKey: "org-a", threadKey: "t" });
        expect(created[1]).toStrictEqual({ input: "hi", threadKey: "t" });
    });
});
