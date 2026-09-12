import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { ERROR_REFERENCE_URL, ERROR_TOOL_DEFINITIONS } from "../src/error-tools";
import { localTools } from "../src/local";
import { callTool, toolDefinitions } from "../src/tools";

/**
 * A client that throws if anything touches it. `lunora_explain_error` answers
 * from the compiled-in catalog, so a round trip here would mean the tool had
 * quietly become deployment-dependent — and `callTool` would report that as a
 * plain `isError`, which every assertion below would otherwise sail past.
 */
const forbiddenClient = (): LunoraClient => {
    const reject = vi.fn<() => Promise<never>>(async () => {
        throw new Error("lunora_explain_error must not reach the deployment");
    });

    return { action: reject, listFunctions: reject, listGlobalTables: reject, mutation: reject, query: reject } as unknown as LunoraClient;
};

/** The `structuredContent` shape this tool emits. */
interface Explanation {
    code?: string;
    docsUrl?: string;
    found?: boolean;
    hint?: string;
    internal?: boolean;
    solution?: { body: string; header: string; id: string };
    status?: number;
    title?: string;
}

const explain = async (input: Record<string, unknown>): Promise<Explanation> => {
    const result = await callTool(forbiddenClient(), "lunora_explain_error", input);

    return result.structuredContent as Explanation;
};

describe("error tool definitions", () => {
    it("declares one read-only tool with an object output schema", () => {
        expect.assertions(4);

        expect(ERROR_TOOL_DEFINITIONS.map((tool) => tool.name)).toStrictEqual(["lunora_explain_error"]);
        expect(ERROR_TOOL_DEFINITIONS.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
        expect(ERROR_TOOL_DEFINITIONS.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
        // Static data: unlike every other tool here, nothing reaches past this process.
        expect(ERROR_TOOL_DEFINITIONS.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
    });

    it("sits in the always-exposed tier, behind neither gate", () => {
        expect.assertions(3);

        expect(toolDefinitions(false).map((tool) => tool.name)).toContain("lunora_explain_error");
        expect(toolDefinitions(false, false).map((tool) => tool.name)).toContain("lunora_explain_error");
        expect(toolDefinitions(true, true).map((tool) => tool.name)).toContain("lunora_explain_error");
    });
});

describe("lunora_explain_error by code", () => {
    it("returns the catalog's status, title and hint, with a docs anchor", async () => {
        expect.assertions(5);

        const explanation = await explain({ code: "CONFLICT" });

        expect(explanation.found).toBe(true);
        expect(explanation.status).toBe(409);
        expect(explanation.title).toBe("Conflict");
        expect(explanation.hint).toContain("optimistic concurrency conflict");
        expect(explanation.docsUrl).toBe(`${ERROR_REFERENCE_URL}#conflict`);
    });

    it("answers for a code the catalog carries no hint for", async () => {
        expect.assertions(4);

        const explanation = await explain({ code: "FUNCTION_NOT_FOUND" });

        expect(explanation.found).toBe(true);
        expect(explanation.status).toBe(404);
        expect(explanation.title).toBe("Function not found");
        expect(explanation.hint).toBeUndefined();
    });

    it("flags an internal code and links to the page, not an anchor", async () => {
        expect.assertions(3);

        // Internal codes are redacted on the wire and deliberately absent from
        // the generated reference, so there is no `#rpc_failed` to link to.
        const explanation = await explain({ code: "RPC_FAILED" });

        expect(explanation.found).toBe(true);
        expect(explanation.internal).toBe(true);
        expect(explanation.docsUrl).toBe(ERROR_REFERENCE_URL);
    });

    it("reads only own catalog keys, so an inherited property is not a code", async () => {
        expect.assertions(2);

        const explanation = await explain({ code: "constructor" });

        expect(explanation.found).toBe(false);
        expect(explanation.status).toBeUndefined();
    });
});

describe("lunora_explain_error by message", () => {
    it("matches a codegen message against the solution rules", async () => {
        expect.assertions(3);

        const explanation = await explain({ message: 'defineSchema(...).extend(...): table "messages" already exists' });

        expect(explanation.found).toBe(true);
        expect(explanation.solution?.id).toBe("lunora-table-duplicate");
        expect(explanation.solution?.header).toBe("Duplicate table name");
    });

    it("matches a Cloudflare platform error from the curated table", async () => {
        expect.assertions(3);

        const explanation = await explain({ message: "Error 1101: Worker threw exception" });

        expect(explanation.found).toBe(true);
        expect(explanation.solution?.id).toBe("cloudflare-error-1101");
        expect(explanation.solution?.body).toContain("wrangler tail");
    });

    it("combines a code lookup with a message match in one answer", async () => {
        expect.assertions(3);

        const explanation = await explain({ code: "CONFLICT", message: "unique constraint violation on users" });

        expect(explanation.status).toBe(409);
        expect(explanation.solution?.id).toBe("lunora-runtime-unique");
        // The catalog hint describes the READ-side conflict; the matched rule
        // describes the write-side unique breach. Both, not one blended answer.
        expect(explanation.hint).not.toBe(explanation.solution?.body);
    });
});

describe("lunora_explain_error refusals and not-found", () => {
    it("returns a clean not-found rather than an error for an unknown code", async () => {
        expect.assertions(4);

        const result = await callTool(forbiddenClient(), "lunora_explain_error", { code: "NOPE_NOT_A_CODE" });
        const explanation = result.structuredContent as Explanation;

        // Not `isError`: a model reads that as a broken tool worth retrying.
        expect(result.isError).toBeUndefined();
        expect(explanation.found).toBe(false);
        expect(explanation.code).toBe("NOPE_NOT_A_CODE");
        expect(explanation.docsUrl).toBe(ERROR_REFERENCE_URL);
    });

    it("returns a clean not-found for a message nothing recognises", async () => {
        expect.assertions(2);

        const explanation = await explain({ message: "something entirely unremarkable happened" });

        expect(explanation.found).toBe(false);
        expect(explanation.docsUrl).toBe(ERROR_REFERENCE_URL);
    });

    it("refuses a call carrying neither a code nor a message", async () => {
        expect.assertions(2);

        const result = await callTool(forbiddenClient(), "lunora_explain_error", {});

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('needs a "code" or a "message"');
    });
});

describe("lunora_explain_error on the local server", () => {
    it("answers even when no dev server is running", async () => {
        expect.assertions(2);

        const tool = localTools({ deployment: () => undefined, docs: false }).find((entry) => entry.definition.name === "lunora_explain_error");
        const result = await tool?.handle({ code: "RLS_REQUIRED" });

        expect(result?.isError).toBeUndefined();
        expect((result?.structuredContent as Explanation | undefined)?.status).toBe(403);
    });

    it("still refuses a deployment tool when nothing is running", async () => {
        expect.assertions(1);

        const tool = localTools({ deployment: () => undefined, docs: false }).find((entry) => entry.definition.name === "lunora_list_functions");
        const result = await tool?.handle({});

        expect(result?.isError).toBe(true);
    });
});
