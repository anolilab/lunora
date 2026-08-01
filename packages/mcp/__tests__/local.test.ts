import type { FunctionDescriptor } from "@lunora/client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { LocalDeployment } from "../src/local";
import { createLocalMcpServer, localTools, NO_DEPLOYMENT_MESSAGE, OPENAPI_RESOURCE_URI, OPENRPC_RESOURCE_URI } from "../src/local";

const FUNCTIONS: FunctionDescriptor[] = [{ args: [], kind: "query", path: "messages:list" }];
const OPENRPC_SPEC = { info: { title: "test", version: "1.0.0" }, methods: [{ name: "messages.list" }], openrpc: "1.3.2" } as const;
const OPENAPI_SPEC = { info: { title: "test", version: "1.0.0" }, openapi: "3.1.0", paths: {} } as const;

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

        if (url.includes("/_lunora/admin/openrpc")) {
            return Response.json(OPENRPC_SPEC, { headers: { "content-type": "application/json" }, status: 200 });
        }

        if (url.includes("/_lunora/admin/openapi")) {
            return Response.json(OPENAPI_SPEC, { headers: { "content-type": "application/json" }, status: 200 });
        }

        return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
    }) as unknown as typeof fetch;

    return { asFetch, urls };
};

/** A `fetch` double whose openrpc/openapi routes 404 — everything else (e.g. docs) still 200s. */
const stubFetchSpecNotFound = (): typeof fetch =>
    vi.fn<(input: string | URL) => Promise<Response>>(async (input) => {
        const url = typeof input === "string" ? input : input.href;

        if (url.includes("/_lunora/admin/openrpc") || url.includes("/_lunora/admin/openapi")) {
            return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
        }

        return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
    }) as unknown as typeof fetch;

const namesOf = (tools: ReadonlyArray<{ definition: { name: string } }>): string[] => tools.map((tool) => tool.definition.name);

/**
 * The low-level SDK `Server` stores request handlers in a private map keyed by
 * request method. We don't drive a transport here; we reach the handlers the
 * same way the SDK does — by looking them up via the request schema's method.
 */
const handlerFor = (server: Server, method: string): ((request: Record<string, unknown>) => unknown) => {
    // eslint-disable-next-line no-underscore-dangle -- reach into the SDK's private handler map; there is no public accessor for registered handlers.
    const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => unknown> })._requestHandlers;
    const handler = handlers.get(method);

    if (handler === undefined) {
        throw new Error(`no handler registered for ${method}`);
    }

    return (request: Record<string, unknown>) => handler({ method, ...request }, { signal: new AbortController().signal });
};

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

        // Compare the parsed origin rather than a string prefix: `startsWith`
        // would also accept `https://worker.example.evil.test`.
        expect(urls.some((url) => new URL(url).origin === "https://worker.example")).toBe(true);
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

describe("deployment spec resources", () => {
    it("lists the OpenRPC/OpenAPI resources alongside docs when a deployment is configured", async () => {
        expect.assertions(1);

        const { asFetch } = stubFetch();
        const server = createLocalMcpServer({ deployment: { url: "https://worker.example" }, fetch: asFetch });

        const listed = (await handlerFor(server, ListResourcesRequestSchema.shape.method.value)({ params: {} })) as {
            resources: { name: string; uri: string }[];
        };

        const uris = listed.resources.map((resource) => resource.uri);

        expect(uris).toStrictEqual(expect.arrayContaining([OPENRPC_RESOURCE_URI, OPENAPI_RESOURCE_URI]));
    });

    it("reads the OpenRPC resource back with the fetched spec", async () => {
        expect.assertions(2);

        const { asFetch } = stubFetch();
        const server = createLocalMcpServer({ deployment: { url: "https://worker.example" }, fetch: asFetch });

        const read = (await handlerFor(server, ReadResourceRequestSchema.shape.method.value)({ params: { uri: OPENRPC_RESOURCE_URI } })) as {
            contents: { mimeType?: string; text: string }[];
        };

        expect(read.contents[0]?.mimeType).toBe("application/json");
        expect(JSON.parse(read.contents[0]?.text ?? "{}")).toStrictEqual(OPENRPC_SPEC);
    });

    it("omits the spec resources without error when the deployment doesn't serve them (404)", async () => {
        expect.assertions(2);

        const server = createLocalMcpServer({ deployment: { url: "https://worker.example" }, fetch: stubFetchSpecNotFound() });

        const listed = (await handlerFor(server, ListResourcesRequestSchema.shape.method.value)({ params: {} })) as {
            resources: { uri: string }[];
        };
        const uris = listed.resources.map((resource) => resource.uri);

        expect(uris).not.toContain(OPENRPC_RESOURCE_URI);
        expect(uris).not.toContain(OPENAPI_RESOURCE_URI);
    });

    it("omits the spec resources when no deployment is configured", async () => {
        expect.assertions(1);

        // Docs stay enabled (stubbed, so no real network) — the resources
        // capability exists via the docs provider; only the deployment side is
        // absent, and that's what this test asserts stays unlisted.
        const { asFetch } = stubFetch();
        const server = createLocalMcpServer({ fetch: asFetch });

        const listed = (await handlerFor(server, ListResourcesRequestSchema.shape.method.value)({ params: {} })) as {
            resources: { uri: string }[];
        };

        expect(listed.resources.map((resource) => resource.uri)).not.toContain(OPENRPC_RESOURCE_URI);
    });

    it("reads through the same admin-gated client the tools use (bearer token forwarded)", async () => {
        expect.assertions(1);

        let sawAuthorization = false;

        const asFetch = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = typeof input === "string" ? input : input.href;
            const headers = new Headers(init?.headers);

            if (url.includes("/_lunora/admin/openrpc")) {
                sawAuthorization = headers.get("authorization") === "Bearer secret-token";

                return Response.json(OPENRPC_SPEC, { headers: { "content-type": "application/json" }, status: 200 });
            }

            return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
        }) as unknown as typeof fetch;

        const server = createLocalMcpServer({ deployment: { token: "secret-token", url: "https://worker.example" }, fetch: asFetch });

        await handlerFor(server, ReadResourceRequestSchema.shape.method.value)({ params: { uri: OPENRPC_RESOURCE_URI } });

        expect(sawAuthorization).toBe(true);
    });
});
