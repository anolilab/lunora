import { describe, expect, it, vi } from "vitest";

import type { MetricEvent } from "../src/observability";
import { axiomMetricsSink } from "../src/observability-presets";

const metric: MetricEvent = {
    functionPath: "messages:list",
    kind: "counter",
    name: "messages.listed",
    ts: 1_700_000_000_000,
    value: 1,
};

describe("axiomMetricsSink", () => {
    it("posts metrics to /v1/metrics with the Bearer token and the metrics dataset", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        try {
            const sink = axiomMetricsSink({ dataset: "metrics-ds", domain: "axiom.example", token: "tok" });

            sink.onMetric?.(metric);
            sink.flush?.();

            await vi.waitFor(() => {
                expect(fetchMock).toHaveBeenCalledTimes(1);
            });

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://axiom.example/v1/metrics");
            expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-axiom-metrics-dataset": "metrics-ds" });
            expect(init.headers).not.toHaveProperty("x-axiom-dataset");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("implements only the metrics hook, so no other signal can be sent", () => {
        expect.hasAssertions();

        const sink = axiomMetricsSink({ dataset: "metrics-ds", domain: "axiom.example", token: "tok" });

        expect(sink.onMetric).toBeDefined();
        expect(sink.onLog).toBeUndefined();
        expect(sink.onRpc).toBeUndefined();
        expect(sink.onSpan).toBeUndefined();
    });
});
