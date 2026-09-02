import { LunoraClient } from "@lunora/client";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLunoraMcpServer } from "../src/server";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): {
    asClient: LunoraClient;
    listFunctions: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
} => {
    const listFunctions = vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]);
    const query = vi.fn<() => Promise<{ count: number }>>(async () => {
        return { count: 7 };
    });

    const client = { listFunctions, query } as unknown as LunoraClient;

    return { asClient: client, listFunctions, query };
};

/**
 * The low-level SDK `Server` stores request handlers in a private map keyed by
 * request method. We don't drive a transport here; we reach the handlers the
 * same way the SDK does — by looking them up via the request schema's method.
 */
const handlerFor = (server: ReturnType<typeof createLunoraMcpServer>, method: string): ((request: Record<string, unknown>) => unknown) => {
    // eslint-disable-next-line no-underscore-dangle -- reach into the SDK's private handler map; there is no public accessor for registered handlers.
    const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => unknown> })._requestHandlers;
    const handler = handlers.get(method);

    if (handler === undefined) {
        throw new Error(`no handler registered for ${method}`);
    }

    // The SDK re-validates the request against its schema (which pins `method`),
    // so inject the method and a minimal `extra` the signature requires.
    return (request: Record<string, unknown>) => handler({ method, ...request }, { signal: new AbortController().signal });
};

describe("resolveClient", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("throws when neither a client nor a url is provided", () => {
        expect.assertions(1);

        expect(() => createLunoraMcpServer({})).toThrow(/requires either a `client` or a `url`/);
    });

    it("wires the token through setAuthToken when constructed from a url", () => {
        expect.assertions(2);

        const setAuthToken = vi.spyOn(LunoraClient.prototype, "setAuthToken").mockImplementation(() => undefined);

        createLunoraMcpServer({ token: "admin-token", url: "https://example.workers.dev" });

        expect(setAuthToken).toHaveBeenCalledTimes(1);
        expect(setAuthToken).toHaveBeenCalledWith("admin-token");
    });

    // Every tool reaches admin-gated `/_lunora/admin/*` routes — introspection,
    // the `assertRunnable` allowlist precheck, and the observability reads — so a
    // tokenless server has no working surface at all. It used to construct fine
    // and advertise a read-only tool list that 403s on first use, while the five
    // privileged tools were hidden by a `token.length > 0` proxy for adminness.
    it("refuses a url with no token instead of advertising tools that can only 403", () => {
        expect.assertions(2);

        const setAuthToken = vi.spyOn(LunoraClient.prototype, "setAuthToken").mockImplementation(() => undefined);

        expect(() => createLunoraMcpServer({ url: "https://example.workers.dev" })).toThrow(/requires a `token`/);
        expect(setAuthToken).not.toHaveBeenCalled();
    });

    it("refuses an empty-string token the same way", () => {
        expect.assertions(1);

        expect(() => createLunoraMcpServer({ token: "", url: "https://example.workers.dev" })).toThrow(/requires a `token`/);
    });
});

describe("createLunoraMcpServer request handlers", () => {
    it("listTools returns only the read-only tools by default", async () => {
        expect.assertions(1);

        const server = createLunoraMcpServer({ client: mockClient().asClient });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(result.tools.map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
        ]);
    });

    it("listTools includes the write tools when allowWrites is set", async () => {
        expect.assertions(1);

        const server = createLunoraMcpServer({ allowWrites: true, client: mockClient().asClient });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(result.tools.map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            "lunora_run_mutation",
            "lunora_run_action",
        ]);
    });

    it("listTools omits the observability tools when no admin token was configured", async () => {
        expect.assertions(1);

        const server = createLunoraMcpServer({ allowWrites: true, client: mockClient().asClient });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        // Privileged reads must not even be advertised on an unauthenticated
        // server — `--allow-writes` is a separate axis and must not imply them.
        expect(result.tools.some((tool) => tool.name.startsWith("lunora_get_") && tool.name !== "lunora_get_function_schema")).toBe(false);
    });

    // The admin bearer is what EVERY tool needs, so deriving the privileged
    // reads from it put production log lines and grouped error messages on the
    // default surface of every server. They are their own opt-in now.
    it("listTools omits the observability tools when only a token is configured", async () => {
        expect.assertions(1);

        const server = createLunoraMcpServer({ client: mockClient().asClient, token: "admin-token" });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(result.tools.map((tool) => tool.name)).not.toContain("lunora_get_logs");
    });

    it("listTools includes the observability tools once allowObservability is set", async () => {
        expect.assertions(2);

        const server = createLunoraMcpServer({ allowObservability: true, client: mockClient().asClient, token: "admin-token" });
        const result = (await handlerFor(server, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(result.tools.map((tool) => tool.name)).toContain("lunora_get_logs");
        // The SDK's Tool schema carries `outputSchema`, so the declaration
        // survives the handler rather than being dropped as an unknown key.
        expect(result.tools.find((tool) => tool.name === "lunora_get_logs")?.outputSchema).toBeDefined();
    });

    it("refuses an observability call fail-closed when it was not opted in", async () => {
        expect.assertions(2);

        const mock = mockClient();
        // The tool isn't advertised, but a client could still name it — dispatch must refuse.
        const server = createLunoraMcpServer({ client: mock.asClient, token: "admin-token" });

        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: {}, name: "lunora_get_logs" },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("dispatches an observability call and returns structuredContent alongside the text block", async () => {
        expect.assertions(3);

        const mock = mockClient();

        mock.query.mockResolvedValueOnce({ entries: [{ level: "info", message: "hello", timestamp: 1 }] });

        const server = createLunoraMcpServer({ allowObservability: true, client: mock.asClient, token: "admin-token" });
        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: {}, name: "lunora_get_logs" },
        })) as CallToolResult;

        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(result.structuredContent).toStrictEqual({ entries: [{ level: "info", message: "hello", timestamp: 1 }], total: 1 });
        expect(JSON.parse((result.content[0] as { text: string }).text)).toStrictEqual(result.structuredContent);
    });

    it("callTool dispatches through callTool against the injected client", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const server = createLunoraMcpServer({ client: mock.asClient });
        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: {}, name: "lunora_list_functions" },
        })) as CallToolResult;

        expect(mock.listFunctions).toHaveBeenCalledTimes(1);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toStrictEqual([{ kind: "query", path: "messages:list" }]);
    });

    it("callTool tolerates a request with no arguments bag (defaults to {})", async () => {
        expect.assertions(1);

        const mock = mockClient();
        const server = createLunoraMcpServer({ client: mock.asClient });

        // No `arguments` key at all — the handler coalesces it to `{}`. With no
        // functionPath this is a validation error surfaced as an error result,
        // which is exactly the contract: the handler must not throw/reject.
        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { name: "lunora_run_query" },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
    });
});

/** A client double exposing the mutation/query the agent tools dispatch. */
const agentClient = (): { asClient: LunoraClient; mutation: ReturnType<typeof vi.fn> } => {
    const mutation = vi.fn<(reference: unknown, arguments_: Record<string, unknown>) => Promise<{ id: string; threadKey: string }>>(async () => {
        return { id: "wf-1", threadKey: "t-agent" };
    });
    const query = vi.fn<(reference: unknown) => Promise<unknown>>(async (reference: unknown) =>
        (reference as { __lunoraRef: string }).__lunoraRef === "agents:agentMessages" ? [{ content: "answer", role: "assistant" }] : { status: "idle" },
    );

    return { asClient: { mutation, query } as unknown as LunoraClient, mutation };
};

const supportExposure = [{ description: "Support", name: "support" }];

describe("createLunoraMcpServer agent tools", () => {
    it("advertises agent tools only when allowAgents is set with a non-empty agents list", async () => {
        expect.assertions(2);

        const withAgents = createLunoraMcpServer({ agents: supportExposure, allowAgents: true, client: mockClient().asClient });
        const withAgentsResult = (await handlerFor(withAgents, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(withAgentsResult.tools.map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            "agent_support",
            "lunora_agent_status",
        ]);

        // Agents listed but not opted in → no agent tools.
        const offServer = createLunoraMcpServer({ agents: supportExposure, client: mockClient().asClient });
        const offResult = (await handlerFor(offServer, ListToolsRequestSchema.shape.method.value)({})) as ListToolsResult;

        expect(offResult.tools.some((tool) => tool.name.startsWith("agent_"))).toBe(false);
    });

    it("routes an agent_<name> call to the agentRun mutation", async () => {
        expect.assertions(2);

        const mock = agentClient();
        const server = createLunoraMcpServer({ agents: supportExposure, agentMaxWaitMs: 10, agentPollIntervalMs: 5, allowAgents: true, client: mock.asClient });

        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: { prompt: "help", threadKey: "t-agent" }, name: "agent_support" },
        })) as CallToolResult;

        expect(mock.mutation).toHaveBeenCalledWith({ __lunoraRef: "agents:agentRun" }, { agent: "support", input: "help", threadKey: "t-agent" });
        expect(JSON.parse((result.content[0] as { text: string }).text)).toStrictEqual({ status: "idle", text: "answer", threadKey: "t-agent" });
    });

    it("refuses an agent call fail-closed when allowAgents is not set", async () => {
        expect.assertions(2);

        const mock = agentClient();
        // The tool isn't advertised, but a client could still name it — dispatch must refuse.
        const server = createLunoraMcpServer({ agents: supportExposure, client: mock.asClient });

        const result = (await handlerFor(
            server,
            CallToolRequestSchema.shape.method.value,
        )({
            params: { arguments: { prompt: "help" }, name: "agent_support" },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(mock.mutation).not.toHaveBeenCalled();
    });
});
