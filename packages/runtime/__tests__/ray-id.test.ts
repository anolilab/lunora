import { describe, expect, it } from "vitest";

import { RAY_ID_HEADER } from "../../../shared/ray-id";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ObservabilityEvent } from "../src/observability";
import { otlpLogBody, otlpSpanBody, otlpTraceBody } from "../src/otlp-export";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * The Cloudflare Ray ID as a cross-navigation key: read off `cf-ray` at the
 * Worker entry, stamped on the request event and the SERVER span, and forwarded
 * to the shard so its logs and spans carry it too. Absent off the edge.
 */

const RAY_ID = "8f2a1b3c4d5e6f70";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A worker over a shard double that records every forwarded request, plus every `onRpc` event. */
const harness = (): { events: ObservabilityEvent[]; forwarded: Request[]; worker: ReturnType<typeof createWorker> } => {
    const events: ObservabilityEvent[] = [];
    const forwarded: Request[] = [];
    const namespace: ShardNamespaceLike = {
        get: () => {
            return {
                fetch: async (request: Request) => {
                    forwarded.push(request);

                    return Response.json({ result: null });
                },
            };
        },
        idFromName: (name: string) => {
            return { __name: name };
        },
    };

    const worker = createWorker({
        allowUnauthenticatedShardAccess: true,
        observability: {
            onRpc: (event) => {
                events.push(event);
            },
        },
        shardDO: namespace,
    });

    return { events, forwarded, worker };
};

const rpc = (headers: Record<string, string> = {}): Request =>
    new Request("https://app.test/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "messages:list" }), headers, method: "POST" });

/** The value of one OTLP attribute, or `undefined`. */
const attribute = (body: unknown, key: string): unknown =>
    ((body as { attributes: { key: string; value: unknown }[] }).attributes ?? []).find((entry) => entry.key === key)?.value;

describe("cloudflare ray id", () => {
    describe("at the worker entry", () => {
        it("stamps the request event and forwards the ray id to the shard when cf-ray is present", async () => {
            expect.assertions(4);

            const { events, forwarded, worker } = harness();
            const response = await worker.fetch(rpc({ "cf-ray": `${RAY_ID}-FRA` }), {}, fakeContext);

            expect(response.status).toBe(200);
            expect(events[0]?.rayId).toBe(RAY_ID);
            // Forwarded next to the traceparent, on the same hop.
            expect(forwarded[0]!.headers.get(RAY_ID_HEADER)).toBe(RAY_ID);
            expect(forwarded[0]!.headers.get("traceparent")).not.toBeNull();
        });

        it("handles a request with no cf-ray (wrangler dev) without a ray id anywhere", async () => {
            expect.assertions(3);

            const { events, forwarded, worker } = harness();
            const response = await worker.fetch(rpc(), {}, fakeContext);

            expect(response.status).toBe(200);
            expect(events[0]).not.toHaveProperty("rayId");
            expect(forwarded[0]!.headers.get(RAY_ID_HEADER)).toBeNull();
        });

        it("never lets a caller smuggle its own x-lunora-ray-id to the shard", async () => {
            expect.assertions(1);

            const { forwarded, worker } = harness();

            await worker.fetch(rpc({ [RAY_ID_HEADER]: RAY_ID }), {}, fakeContext);

            expect(forwarded[0]!.headers.get(RAY_ID_HEADER)).toBeNull();
        });

        it("does not echo the ray id onto the client-visible response", async () => {
            expect.assertions(1);

            const { worker } = harness();
            const response = await worker.fetch(rpc({ "cf-ray": `${RAY_ID}-FRA` }), {}, fakeContext);

            expect([...response.headers.values()].some((value) => value.includes(RAY_ID))).toBe(false);
        });
    });

    describe("on the OTLP wire", () => {
        it("puts cloudflare.ray_id on the SERVER span", () => {
            expect.assertions(2);

            const span = otlpTraceBody({ durationMs: 3, functionPath: "messages:list", ok: true, rayId: RAY_ID }, Date.now());
            const withoutRay = otlpTraceBody({ durationMs: 3, functionPath: "messages:list", ok: true }, Date.now());

            expect(attribute(span, "cloudflare.ray_id")).toStrictEqual({ stringValue: RAY_ID });
            expect(attribute(withoutRay, "cloudflare.ray_id")).toBeUndefined();
        });

        it("puts cloudflare.ray_id on shard-side ctx.trace spans and ctx.log records", () => {
            expect.assertions(2);

            const span = otlpSpanBody({
                durationMs: 1,
                functionPath: "messages:list",
                name: "work",
                ok: true,
                parentSpanId: "b7ad6b7169203331",
                rayId: RAY_ID,
                spanId: "00f067aa0ba902b7",
                startTs: 1,
                traceId: "0af7651916cd43dd8448eb211c80319c",
            });
            const log = otlpLogBody({ args: [], functionPath: "messages:list", level: "info", message: "hi", rayId: RAY_ID, ts: 1 });

            expect(attribute(span, "cloudflare.ray_id")).toStrictEqual({ stringValue: RAY_ID });
            expect(attribute(log, "cloudflare.ray_id")).toStrictEqual({ stringValue: RAY_ID });
        });
    });
});
