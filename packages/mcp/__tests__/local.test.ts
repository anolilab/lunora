import type { FunctionDescriptor } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import type { LocalDeployment } from "../src/local";
import { localTools, NO_DEPLOYMENT_MESSAGE } from "../src/local";

const FUNCTIONS: FunctionDescriptor[] = [{ args: [], kind: "query", path: "messages:list" }];

/**
 * A `fetch` double standing in for both the docs site and a Lunora deployment,
 * so `localTools` can be exercised end to end without a network.
 */
const stubFetch = (): { asFetch: typeof fetch; urls: string[] } => {
    const urls: string[] = [];

    const asFetch = vi.fn<(input: string | URL) => Promise<Response>>(async (input) => {
        const url = typeof input === "string" ? input : input.href;

        urls.push(url);

        if (url.includes("/_lunora/admin/functions")) {
            return Response.json({ functions: FUNCTIONS }, { headers: { "content-type": "application/json" }, status: 200 });
        }

        return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
    }) as unknown as typeof fetch;

    return { asFetch, urls };
};

const namesOf = (tools: ReadonlyArray<{ definition: { name: string } }>): string[] => tools.map((tool) => tool.definition.name);

describe("localTools", () => {
    it("serves documentation tools even with no deployment", () => {
        expect.assertions(2);

        const names = namesOf(localTools({}));

        expect(names).toContain("lunora_search_docs");
        expect(names).not.toContain("lunora_run_query");
    });

    it("omits the documentation tools when docs is false", () => {
        expect.assertions(1);

        expect(namesOf(localTools({ docs: false }))).toStrictEqual([]);
    });

    it("advertises the deployment tools even when the resolver currently finds nothing", () => {
        expect.assertions(2);

        const names = namesOf(localTools({ deployment: () => undefined, docs: false }));

        // The tool list is read once and cached by MCP clients, so the surface
        // must not depend on whether the dev server happened to be up.
        expect(names).toContain("lunora_run_query");
        expect(names).toContain("lunora_list_functions");
    });

    it("hides the write tools unless allowWrites is set", () => {
        expect.assertions(2);

        expect(namesOf(localTools({ deployment: () => undefined, docs: false }))).not.toContain("lunora_run_mutation");
        expect(namesOf(localTools({ allowWrites: true, deployment: () => undefined, docs: false }))).toContain("lunora_run_mutation");
    });

    it("tells the caller to start the dev server when a deployment tool is used with none running", async () => {
        expect.assertions(2);

        const tools = localTools({ deployment: () => undefined, docs: false });
        const listFunctions = tools.find((tool) => tool.definition.name === "lunora_list_functions");
        const result = await listFunctions?.handle({});

        expect(result?.isError).toBe(true);
        expect(result?.content[0]?.text).toBe(NO_DEPLOYMENT_MESSAGE);
    });

    it("picks up a deployment that appears after the tools were built", async () => {
        expect.assertions(2);

        const { asFetch, urls } = stubFetch();
        let deployment: LocalDeployment | undefined;

        const tools = localTools({ deployment: () => deployment, docs: false, fetch: asFetch });
        const listFunctions = tools.find((tool) => tool.definition.name === "lunora_list_functions");

        const beforeStart = await listFunctions?.handle({});

        expect(beforeStart?.isError).toBe(true);

        deployment = { token: "t", url: "https://worker.example" };

        await listFunctions?.handle({});

        expect(urls.some((url) => url.startsWith("https://worker.example"))).toBe(true);
    });

    it("reuses one client per deployment so the function registry stays cached", async () => {
        expect.assertions(1);

        const { asFetch, urls } = stubFetch();
        const tools = localTools({ deployment: { url: "https://worker.example" }, docs: false, fetch: asFetch });
        const listFunctions = tools.find((tool) => tool.definition.name === "lunora_list_functions");

        await listFunctions?.handle({});
        await listFunctions?.handle({});

        // A fresh client per call would defeat the per-client registry memo and
        // refetch on the second call.
        expect(urls.filter((url) => url.includes("/_lunora/admin/functions"))).toHaveLength(1);
    });

    it("orders the surfaces docs → extras → deployment", () => {
        expect.assertions(1);

        const extra = {
            definition: { description: "x", inputSchema: { properties: {}, type: "object" as const }, name: "custom" },
            handle: async () => {
                return { content: [] };
            },
        };

        const names = namesOf(localTools({ deployment: () => undefined, extraTools: [extra] }));

        expect(names.indexOf("lunora_search_docs")).toBeLessThan(names.indexOf("custom"));
    });
});
