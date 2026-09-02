import type { FunctionDescriptor, LunoraClient } from "@lunora/client";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, OBSERVABILITY_TOOL_DEFINITIONS } from "../src/observability-tools";
import { callTool, toolDefinitions } from "../src/tools";

const OBSERVABILITY_NAMES = ["lunora_get_logs", "lunora_get_issues", "lunora_get_advisories", "lunora_get_query_insights", "lunora_get_migration_status"];

/** A log ring entry, as `__lunora_admin__:getLogs` returns it (newest first). */
const logEntry = (index: number, level: string): Record<string, unknown> => {
    return { level, message: `line ${index.toString()}`, timestamp: 1000 + index };
};

/**
 * Mock client whose `query` answers per admin op path, so a test asserts the
 * op the tool chose rather than a positional call index.
 */
const mockClient = (
    results: Record<string, unknown> = {},
): {
    asClient: LunoraClient;
    query: ReturnType<typeof vi.fn>;
} => {
    const query = vi.fn<(reference: { __lunoraRef: string }) => Promise<unknown>>(async (reference) => results[reference.__lunoraRef] ?? {});
    const listFunctions = vi.fn<() => Promise<FunctionDescriptor[]>>(async () => []);

    return { asClient: { listFunctions, query } as unknown as LunoraClient, query };
};

describe("observability tool definitions", () => {
    it("declares five tools, each read-only and carrying an outputSchema", () => {
        expect.assertions(3);

        expect(OBSERVABILITY_TOOL_DEFINITIONS.map((tool) => tool.name)).toStrictEqual(OBSERVABILITY_NAMES);
        expect(OBSERVABILITY_TOOL_DEFINITIONS.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
        // The MCP spec requires an output schema to be an object at the root.
        expect(OBSERVABILITY_TOOL_DEFINITIONS.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
    });

    it("gives every tool a title and a description that says when to call it", () => {
        expect.assertions(2);

        expect(OBSERVABILITY_TOOL_DEFINITIONS.every((tool) => (tool.annotations?.title ?? "").length > 0)).toBe(true);
        expect(OBSERVABILITY_TOOL_DEFINITIONS.every((tool) => tool.description.length > 40)).toBe(true);
    });
});

describe("observability-tier gating", () => {
    it("omits the observability tools from the advertised list without the opt-in", () => {
        expect.assertions(2);

        const names = toolDefinitions(false).map((tool) => tool.name);

        expect(names).toStrictEqual(["lunora_list_functions", "lunora_list_tables", "lunora_get_function_schema", "lunora_run_query"]);
        expect(names.some((name) => OBSERVABILITY_NAMES.includes(name))).toBe(false);
    });

    it("advertises them once opted in, without disturbing the write tier", () => {
        expect.assertions(2);

        expect(toolDefinitions(false, true).map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            ...OBSERVABILITY_NAMES,
        ]);
        expect(toolDefinitions(true, true).map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            ...OBSERVABILITY_NAMES,
            "lunora_run_mutation",
            "lunora_run_action",
        ]);
    });

    it("keeps the observability tier independent of the write tier", () => {
        expect.assertions(1);

        // `--allow-writes` must not smuggle in the privileged reads.
        expect(toolDefinitions(true).map((tool) => tool.name)).toStrictEqual([
            "lunora_list_functions",
            "lunora_list_tables",
            "lunora_get_function_schema",
            "lunora_run_query",
            "lunora_run_mutation",
            "lunora_run_action",
        ]);
    });

    it.each(OBSERVABILITY_NAMES)("refuses %s at dispatch without the opt-in, without touching the client", async (name) => {
        expect.assertions(3);

        const mock = mockClient();
        const result = await callTool(mock.asClient, name, {});

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("LUNORA_MCP_ALLOW_OBSERVABILITY");
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("refuses at dispatch even when writes are enabled but observability is not", async () => {
        expect.assertions(2);

        const mock = mockClient();
        const result = await callTool(mock.asClient, "lunora_get_logs", {}, true);

        expect(result.isError).toBe(true);
        expect(mock.query).not.toHaveBeenCalled();
    });
});

describe("lunora_get_logs", () => {
    it("reads the getLogs admin op and returns the newest entries", async () => {
        expect.assertions(4);

        const entries = [logEntry(1, "error"), logEntry(2, "info"), logEntry(3, "warn")];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", { limit: 2 }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getLogs }, {}, {});
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toStrictEqual({ entries: [entries[0], entries[1]], total: 3 });
        // The text block stays, for a client on a pre-2025-06-18 revision.
        expect(JSON.parse(result.content[0]!.text)).toStrictEqual(result.structuredContent);
    });

    it("filters by level before limiting, and reports the pre-limit total", async () => {
        expect.assertions(2);

        const entries = [logEntry(1, "info"), logEntry(2, "error"), logEntry(3, "error")];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", { level: "error", limit: 1 }, false, true);

        expect(result.structuredContent).toStrictEqual({ entries: [entries[1]], total: 2 });
        expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(1);
    });

    it("ignores an unrecognized level rather than filtering everything out", async () => {
        expect.assertions(1);

        const entries = [logEntry(1, "info")];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", { level: "LOUD" }, false, true);

        expect(result.structuredContent).toStrictEqual({ entries, total: 1 });
    });

    it("forwards a shardKey, since these reads are per-shard", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries: [] } });

        await callTool(mock.asClient, "lunora_get_logs", { shardKey: "room-1" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getLogs }, {}, { shardKey: "room-1" });
    });

    it("survives a deployment that answers with no entries array", async () => {
        expect.assertions(2);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: {} });
        const result = await callTool(mock.asClient, "lunora_get_logs", {}, false, true);

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toStrictEqual({ entries: [], total: 0 });
    });

    it("maps a bigint / bytes leaf so structuredContent survives the transport's JSON.stringify", async () => {
        expect.assertions(3);

        // `LunoraClient` decodes every response, so a `v.int64()` field logged
        // into `fields` reaches the tool as a real bigint. Left unmapped it
        // would throw when the transport serializes `structuredContent`.
        const entries = [{ fields: { blob: new Uint8Array([1, 2, 3]), id: 9_007_199_254_740_993n }, level: "info", message: "m", timestamp: 1 }];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", {}, false, true);

        expect(result.isError).toBeUndefined();
        expect(() => JSON.stringify(result.structuredContent)).not.toThrow();
        expect(result.structuredContent).toStrictEqual({
            entries: [{ fields: { blob: "AQID", id: "9007199254740993" }, level: "info", message: "m", timestamp: 1 }],
            total: 1,
        });
    });
});

describe("limit clamping", () => {
    const manyEntries = Array.from({ length: MAX_LIMIT + 25 }, (_, index) => logEntry(index, "info"));

    it("defaults a missing limit", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries: manyEntries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", {}, false, true);

        expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(DEFAULT_LIMIT);
    });

    it("clamps a limit above the ceiling", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getLogs]: { entries: manyEntries } });
        const result = await callTool(mock.asClient, "lunora_get_logs", { limit: 100_000 }, false, true);

        expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(MAX_LIMIT);
    });

    it("clamps a zero/negative limit up to one", async () => {
        expect.assertions(2);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getIssues]: { issues: [] } });

        await callTool(mock.asClient, "lunora_get_issues", { limit: 0 }, false, true);
        await callTool(mock.asClient, "lunora_get_issues", { limit: -5 }, false, true);

        expect(mock.query).toHaveBeenNthCalledWith(1, { __lunoraRef: ADMIN_FUNCTIONS.getIssues }, { limit: 1 }, {});
        expect(mock.query).toHaveBeenNthCalledWith(2, { __lunoraRef: ADMIN_FUNCTIONS.getIssues }, { limit: 1 }, {});
    });

    it("falls back to the default for a non-numeric limit", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getIssues]: { issues: [] } });

        await callTool(mock.asClient, "lunora_get_issues", { limit: "lots" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getIssues }, { limit: DEFAULT_LIMIT }, {});
    });
});

describe("lunora_get_issues", () => {
    it("pushes limit/status/functionPathPrefix down to the RPC so grouping sees the right rows", async () => {
        expect.assertions(2);

        const issues = [{ count: 3, hash: "abc", title: "boom" }];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getIssues]: { issues } });
        const result = await callTool(mock.asClient, "lunora_get_issues", { functionPathPrefix: "messages:", limit: 10, status: "open" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getIssues }, { functionPathPrefix: "messages:", limit: 10, status: "open" }, {});
        expect(result.structuredContent).toStrictEqual({ issues });
    });

    it("drops an unrecognized status instead of forwarding it", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getIssues]: { issues: [] } });

        await callTool(mock.asClient, "lunora_get_issues", { status: "on-fire" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getIssues }, { limit: DEFAULT_LIMIT }, {});
    });
});

describe("the remaining reads", () => {
    it("lunora_get_advisories limits and reports the total", async () => {
        expect.assertions(2);

        const advisories = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const mock = mockClient({ [ADMIN_FUNCTIONS.getAdvisories]: { advisories } });
        const result = await callTool(mock.asClient, "lunora_get_advisories", { limit: 2 }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getAdvisories }, {}, {});
        expect(result.structuredContent).toStrictEqual({ advisories: [{ id: "a" }, { id: "b" }], total: 3 });
    });

    it("lunora_get_query_insights forwards a known range and passes the series through", async () => {
        expect.assertions(2);

        const insights = { buckets: [{ bucketMs: 1 }], capped: true, entries: [{ sql: "select 1" }], trackedStatements: 42 };
        const mock = mockClient({ [ADMIN_FUNCTIONS.getQueryInsights]: insights });
        const result = await callTool(mock.asClient, "lunora_get_query_insights", { range: "1h" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getQueryInsights }, { range: "1h" }, {});
        expect(result.structuredContent).toStrictEqual({
            buckets: insights.buckets,
            capped: true,
            entries: insights.entries,
            total: 1,
            trackedStatements: 42,
        });
    });

    it("lunora_get_query_insights drops an unknown range so the RPC applies its own default", async () => {
        expect.assertions(1);

        const mock = mockClient({ [ADMIN_FUNCTIONS.getQueryInsights]: { buckets: [], entries: [] } });

        await callTool(mock.asClient, "lunora_get_query_insights", { range: "forever" }, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.getQueryInsights }, {}, {});
    });

    it("lunora_get_migration_status returns every migration, untruncated", async () => {
        expect.assertions(2);

        const migrations = Array.from({ length: DEFAULT_LIMIT + 10 }, (_, index) => {
            return { applied: index % 2 === 0, id: index.toString() };
        });
        const mock = mockClient({ [ADMIN_FUNCTIONS.migrationStatus]: { migrations } });
        const result = await callTool(mock.asClient, "lunora_get_migration_status", {}, false, true);

        expect(mock.query).toHaveBeenCalledWith({ __lunoraRef: ADMIN_FUNCTIONS.migrationStatus }, {}, {});
        // Truncating this list would hide exactly the pending migration asked about.
        expect((result.structuredContent as { migrations: unknown[] }).migrations).toHaveLength(migrations.length);
    });

    it("surfaces a failed admin read as an error result rather than rejecting", async () => {
        expect.assertions(2);

        const mock = mockClient();

        mock.query.mockRejectedValueOnce(new Error("ADMIN_FORBIDDEN"));

        const result = await callTool(mock.asClient, "lunora_get_logs", {}, false, true);

        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("ADMIN_FORBIDDEN");
    });
});
