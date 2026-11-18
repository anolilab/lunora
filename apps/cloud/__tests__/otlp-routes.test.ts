import { describe, expect, it } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import readJson from "./_helpers/read-json";

/**
 * Handler-level tests for the standard OTLP ingest routes: exercise auth, the
 * two transports, and the `partialSuccess` cap through the real router (with a
 * fake Lunora action context). `orgForDeployKey` resolves only `"valid"`; the
 * ingest mutations are no-ops (we assert the HTTP contract, not persistence).
 */
const context = {
    runAction: async (): Promise<unknown> => {
        return {};
    },
    runMutation: async (): Promise<unknown> => {
        return { alerts: [], incidents: 0, issues: 0 };
    },
    runQuery: async (_reference: unknown, args: { deployKey?: string }): Promise<unknown> => (args.deployKey === "valid" ? { organizationId: "org_1" } : null),
};

const environment = { __lunoraCtx: context } as unknown;

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> =>
    createDeployRouter().fetch(new Request(`https://cloud.test${path}`, { body, headers, method: "POST" }), environment);

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    post(path, JSON.stringify(body), { "content-type": "application/json", ...headers });

/** One OK worker span with valid ids + timing. */
const okSpan = (index: number): Record<string, unknown> => {
    return {
        endTimeUnixNano: "1700000000100000000",
        name: "messages:send",
        spanId: `span${String(index)}`,
        startTimeUnixNano: "1700000000000000000",
        status: { code: 1 },
        traceId: `trace${String(index)}`,
    };
};

describe("oTLP ingest routes", () => {
    it("401s a request with no bearer token", async () => {
        const response = await jsonPost("/v1/traces", { resourceSpans: [] });

        expect(response.status).toBe(401);
    });

    it("401s a request with an unknown key", async () => {
        const response = await jsonPost("/v1/traces", { resourceSpans: [] }, { authorization: "Bearer nope" });

        expect(response.status).toBe(401);
    });

    it("accepts a valid JSON trace batch with an empty success body", async () => {
        const response = await jsonPost("/v1/traces", { resourceSpans: [] }, { authorization: "Bearer valid" });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({});
    });

    it("reports partialSuccess when the span batch exceeds the cap", async () => {
        const spans = Array.from({ length: 1100 }, (_unused, index) => okSpan(index));
        const response = await jsonPost(
            "/v1/traces",
            { resourceSpans: [{ scopeSpans: [{ scope: { name: "@lunora/runtime" }, spans }] }] },
            { authorization: "Bearer valid" },
        );

        const body = await readJson<{ partialSuccess: { rejectedSpans: number } }>(response);

        expect(response.status).toBe(200);
        expect(body.partialSuccess.rejectedSpans).toBe(100);
    });

    it("trims error events to the ingest cap instead of losing the batch", async () => {
        const ingested: number[] = [];
        // Mirrors `telemetry.ingest`, which refuses a call over 500 events.
        const capped = {
            ...context,
            runMutation: async (_reference: unknown, args: { events: unknown[] }): Promise<unknown> => {
                if (args.events.length > 500) {
                    throw new Error("batch too large (max 500 events)");
                }

                ingested.push(args.events.length);

                return { alerts: [], incidents: 0, issues: 0 };
            },
        };
        const spans = Array.from({ length: 501 }, (_unused, index) => {
            return { ...okSpan(index), status: { code: 2, message: "boom" } };
        });
        const response = await createDeployRouter().fetch(
            new Request("https://cloud.test/v1/traces", {
                body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: "@lunora/runtime" }, spans }] }] }),
                headers: { authorization: "Bearer valid", "content-type": "application/json" },
                method: "POST",
            }),
            { __lunoraCtx: capped },
        );

        const body = await readJson<{ partialSuccess: { rejectedSpans: number } }>(response);

        expect(response.status).toBe(200);
        expect(ingested).toStrictEqual([500]);
        expect(body.partialSuccess.rejectedSpans).toBe(1);
    });

    it("archives the decoded error events alongside the spans, like the native telemetry route", async () => {
        expect.assertions(1);

        const archived: string[] = [];
        const TELEMETRY_PIPELINE = {
            send: async (records: { recordType?: string }[]) => {
                archived.push(...records.map((record) => record.recordType ?? "event"));
            },
        };
        const spans = [{ ...okSpan(1), status: { code: 2, message: "boom" } }];

        await createDeployRouter().fetch(
            new Request("https://cloud.test/v1/traces", {
                body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: "@lunora/runtime" }, spans }] }] }),
                headers: { authorization: "Bearer valid", "content-type": "application/json" },
                method: "POST",
            }),
            { __lunoraCtx: context, TELEMETRY_PIPELINE },
        );

        expect(archived).toStrictEqual(["event", "span"]);
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
