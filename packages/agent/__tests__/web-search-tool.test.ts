import { describe, expect, it } from "vitest";

import type { AgentToolContext } from "../src/types";
import { webSearchTool } from "../src/web-search-tool";
import { passthroughStep } from "./loop-harness";

const items = [{ title: "Lunora", url: "https://lunora.sh" }];

const NO_BINDING = /no `AI` binding/u;
const REJECTED_REQUEST = /^Web search failed: .*query too long/u;

/** A minimal `AgentToolContext` whose `env` carries the given `AI` binding. */
const toolContext = (ai: unknown): AgentToolContext => {
    return {
        env: ai === undefined ? {} : { AI: ai },
        getState: async () => undefined,
        idempotencyKey: "tool:search:call_1",
        reportProgress: () => {},
        run: async () => undefined,
        setState: async () => {},
        step: passthroughStep,
        threadKey: "thread-1",
        toolCallId: "call_1",
    };
};

/** An `AI` binding double whose `websearch()` records its input and answers with `response`. */
const searchBinding = (response: () => Response): { calls: unknown[]; run: () => Promise<undefined>; websearch: (input: unknown) => Promise<Response> } => {
    const calls: unknown[] = [];

    return {
        calls,
        run: async () => undefined,
        websearch: async (input: unknown) => {
            calls.push(input);

            return response();
        },
    };
};

describe(webSearchTool, () => {
    it("searches with the configured provider and a small default limit, and returns the items", async () => {
        expect.assertions(2);

        const binding = searchBinding(() => Response.json({ items, metadata: { latencyMs: 1, query: "q", requestId: "r" } }));
        const output = await webSearchTool({ byokAlias: "team", provider: "linkup" }).execute({ query: "lunora framework" }, toolContext(binding));

        expect(binding.calls).toStrictEqual([{ byokAlias: "team", gatewayId: "default", limit: 5, provider: "linkup", query: "lunora framework" }]);
        expect(output).toStrictEqual(items);
    });

    it("answers the model instead of failing the run when there is no AI binding", async () => {
        expect.assertions(1);

        await expect(webSearchTool().execute({ query: "q" }, toolContext(undefined))).resolves.toMatch(NO_BINDING);
    });

    it("hands a rejected request back to the model, but rethrows a retryable failure", async () => {
        expect.assertions(2);

        const rejected = searchBinding(() => new Response("query too long", { status: 400 }));
        const throttled = searchBinding(() => new Response("slow down", { status: 429 }));

        await expect(webSearchTool().execute({ query: "q" }, toolContext(rejected))).resolves.toMatch(REJECTED_REQUEST);
        await expect(webSearchTool().execute({ query: "q" }, toolContext(throttled))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });
});
