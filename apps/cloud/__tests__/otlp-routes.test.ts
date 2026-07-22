import { describe, expect, it } from "vitest";

import { createDeployRouter } from "../src/deploy/router";

/**
 * Handler-level tests for the standard OTLP ingest routes: exercise auth, the
 * two transports, and the `partialSuccess` cap through the real router (with a
 * fake Lunora action context). `orgForDeployKey` resolves only `"valid"`; the
 * ingest mutations are no-ops (we assert the HTTP contract, not persistence).
 */
const context = {
    runAction: async (): Promise<unknown> => ({}),
    runMutation: async (): Promise<unknown> => ({ alerts: [], incidents: 0, issues: 0 }),
    runQuery: async (_reference: unknown, args: { deployKey?: string }): Promise<unknown> => (args.deployKey === "valid" ? { organizationId: "org_1" } : null),
};

const environment = { __lunoraCtx: context } as unknown;

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> =>
    createDeployRouter().fetch(new Request(`https://cloud.test${path}`, { body, headers, method: "POST" }), environment) as Promise<Response>;

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    post(path, JSON.stringify(body), { "content-type": "application/json", ...headers });

/** One OK worker span with valid ids + timing. */
const okSpan = (index: number): Record<string, unknown> => ({
    endTimeUnixNano: "1700000000100000000",
    name: "messages:send",
    spanId: `span${String(index)}`,
    startTimeUnixNano: "1700000000000000000",
    status: { code: 1 },
    traceId: `trace${String(index)}`,
});

describe("OTLP ingest routes", () => {
    it("401s a request with no bearer token", async () => {
        expect((await jsonPost("/v1/traces", { resourceSpans: [] })).status).toBe(401);
    });

    it("401s a request with an unknown key", async () => {
        expect((await jsonPost("/v1/traces", { resourceSpans: [] }, { authorization: "Bearer nope" })).status).toBe(401);
    });

    it("accepts a valid JSON trace batch with an empty success body", async () => {
        const response = await jsonPost("/v1/traces", { resourceSpans: [] }, { authorization: "Bearer valid" });

        expect(response.status).toBe(200);
        expect(await response.json()).toStrictEqual({});
    });

    it("reports partialSuccess when the span batch exceeds the cap", async () => {
        const spans = Array.from({ length: 1100 }, (_unused, index) => okSpan(index));
        const response = await jsonPost(
            "/v1/traces",
            { resourceSpans: [{ scopeSpans: [{ scope: { name: "@lunora/runtime" }, spans }] }] },
            { authorization: "Bearer valid" },
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { partialSuccess: { rejectedSpans: number } }).partialSuccess.rejectedSpans).toBe(100);
    });

    it("accepts an OTLP/protobuf body (no longer 415s it)", async () => {
        const response = await post("/v1/traces", new Uint8Array(), { authorization: "Bearer valid", "content-type": "application/x-protobuf" });

        expect(response.status).toBe(200);
    });

    it("accepts a valid metrics batch", async () => {
        const response = await jsonPost("/v1/metrics", { resourceMetrics: [] }, { authorization: "Bearer valid" });

        expect(response.status).toBe(200);
    });
});
