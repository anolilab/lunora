import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { defineAgent } from "../src/define-agent";
import { functionTool } from "../src/function-tool";
import type { AgentToolContext } from "../src/types";
import { DurableStepJournal, loopDefaults, memoryRuntime, scriptedGenerate, toolTurn } from "./loop-harness";

/** A minimal `AgentToolContext` for driving `execute` directly. */
const toolContext = (run: AgentToolContext["run"], overrides?: Partial<AgentToolContext>): AgentToolContext => {
    return {
        env: {},
        getState: async () => undefined,
        idempotencyKey: "tool:lookupOrder:call_1",
        reportProgress: () => {},
        run,
        setState: async () => {},
        threadKey: "thread-1",
        toolCallId: "call_1",
        ...overrides,
    };
};

const inputSchema = jsonSchema<{ id: string }>({ properties: { id: { type: "string" } }, required: ["id"], type: "object" });

const NON_EMPTY_DESCRIPTION = /non-empty `description`/u;
const REQUIRES_INPUT_SCHEMA = /requires an `inputSchema`/u;

describe(functionTool, () => {
    it("dispatches the referenced function via the run seam with the model input as args", async () => {
        const seen: { args: Record<string, unknown> | undefined; ref: string }[] = [];

        const run: AgentToolContext["run"] = async (reference, args) => {
            seen.push({ args, ref: reference["__lunoraRef"] });

            return { id: args?.["id"], status: "shipped" };
        };

        const tool = functionTool("orders:byId", { description: "Look up an order by id.", inputSchema });
        const output = await tool.execute({ id: "o_42" }, toolContext(run));

        expect(seen).toStrictEqual([{ args: { id: "o_42" }, ref: "orders:byId" }]);
        expect(output).toStrictEqual({ id: "o_42", status: "shipped" });
    });

    it("accepts a pre-minted function reference and passes it through unchanged", async () => {
        const seen: string[] = [];

        const run: AgentToolContext["run"] = async (reference) => {
            seen.push(reference["__lunoraRef"]);

            return null;
        };

        const tool = functionTool({ __lunoraRef: "orders:byId" }, { description: "Look up an order.", inputSchema });

        await tool.execute({ id: "o_1" }, toolContext(run));

        expect(seen).toStrictEqual(["orders:byId"]);
    });

    it("runs inside the loop's durable tool step and persists the function result", async () => {
        const runtime = memoryRuntime();
        const journal = new DurableStepJournal();

        const agent = defineAgent({
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            tools: {
                lookupOrder: functionTool("orders:byId", { description: "Look up an order by id.", inputSchema }),
            },
        });

        // The function tool dispatches through the SAME `run` seam the loop uses,
        // so the harness runtime must resolve `orders:byId` too.
        const baseRun = runtime.run;
        const run: typeof baseRun = async (reference, args) => {
            if (reference["__lunoraRef"] === "orders:byId") {
                return `order ${String(args?.["id"])} is shipped`;
            }

            return baseRun(reference, args);
        };

        const generate = scriptedGenerate([toolTurn("call_1", "lookupOrder", { id: "o_42" }, "checking…"), { text: "It shipped.", toolCalls: [] }]);

        const result = await runAgentLoop(loopDefaults(agent, { generate, run, step: journal }));

        expect(result.stopped).toBe("final");
        expect(journal.invoked).toStrictEqual(["llm:turn:0", "tool:lookupOrder:call_1", "llm:turn:1"]);

        const thread = [...runtime.messages.values()].toSorted((a, b) => a.seq - b.seq);
        const toolRow = thread.find((message) => message.role === "tool");

        expect(toolRow?.content).toBe("order o_42 is shipped");
        expect(toolRow?.toolCallId).toBe("call_1");
    });

    it("rejects an empty description and a missing schema", () => {
        expect(() => functionTool("orders:byId", { description: "", inputSchema })).toThrow(NON_EMPTY_DESCRIPTION);
        expect(() => functionTool("orders:byId", { description: "ok", inputSchema: undefined as never })).toThrow(REQUIRES_INPUT_SCHEMA);
    });
});
