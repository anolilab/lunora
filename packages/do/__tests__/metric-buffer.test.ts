/* eslint-disable unicorn/prefer-single-call -- `buffer.push` is MetricBuffer's single-arg method, not Array#push; combining the calls would silently drop all but the first event */
import { describe, expect, it } from "vitest";

import type { MetricEvent } from "../../../shared/metric-event";
import { MetricBuffer } from "../src/metric-buffer";

/** Build a MetricEvent with sensible defaults so each test states only what it exercises. */
const event = (over: Partial<MetricEvent> & Pick<MetricEvent, "kind" | "name" | "value">): MetricEvent => {
    return {
        functionPath: "orders:checkout",
        ts: 1000,
        ...over,
    };
};

describe("metricBuffer", () => {
    it("carries the latest exemplar traceId, keeping a prior one when a later sample has none", () => {
        expect.assertions(3);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "orders.placed", traceId: "trace-a", value: 1 }));

        expect(buffer.entries()[0]?.exemplarTraceId).toBe("trace-a");

        buffer.push(event({ kind: "counter", name: "orders.placed", traceId: "trace-b", value: 1 }));

        expect(buffer.entries()[0]?.exemplarTraceId).toBe("trace-b");

        // A later measurement without a trace leaves the exemplar intact.
        buffer.push(event({ kind: "counter", name: "orders.placed", value: 1 }));

        expect(buffer.entries()[0]?.exemplarTraceId).toBe("trace-b");
    });

    it("folds repeated counter measurements into one running series", () => {
        expect.assertions(6);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "orders.placed", ts: 1000, value: 2 }));
        buffer.push(event({ kind: "counter", name: "orders.placed", ts: 1005, value: 3 }));

        const [series] = buffer.entries();

        expect(buffer.size).toBe(1);
        expect(series?.count).toBe(2);
        expect(series?.sum).toBe(5);
        expect(series?.last).toBe(3);
        expect(series?.firstTs).toBe(1000);
        expect(series?.lastTs).toBe(1005);
    });

    it("tracks min/max/last across histogram samples", () => {
        expect.assertions(4);

        const buffer = new MetricBuffer();

        for (const value of [10, 3, 7, 20]) {
            buffer.push(event({ kind: "histogram", name: "checkout.ms", value }));
        }

        const [series] = buffer.entries();

        expect(series?.min).toBe(3);
        expect(series?.max).toBe(20);
        expect(series?.last).toBe(20);
        expect(series?.sum).toBe(40);
    });

    it("keeps series with the same name but different kind or dimensions distinct", () => {
        expect.assertions(3);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "http.requests", value: 1 }));
        buffer.push(event({ kind: "gauge", name: "http.requests", value: 1 }));
        buffer.push(event({ attributes: { route: "/a" }, kind: "counter", name: "http.requests", value: 1 }));
        buffer.push(event({ attributes: { route: "/b" }, kind: "counter", name: "http.requests", value: 1 }));

        expect(buffer.size).toBe(4);

        // Dimension order must not create a distinct series.
        buffer.push(event({ attributes: { region: "eu", route: "/a" }, kind: "counter", name: "http.requests", value: 1 }));
        buffer.push(event({ attributes: { route: "/a", region: "eu" }, kind: "counter", name: "http.requests", value: 1 }));

        expect(buffer.size).toBe(5);

        const folded = buffer.entries().find((s) => s.attributes?.region === "eu" && s.attributes.route === "/a");

        expect(folded?.count).toBe(2);
    });

    it("returns series most-recently-updated first", () => {
        expect.assertions(1);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "a", value: 1 }));
        buffer.push(event({ kind: "counter", name: "b", value: 1 }));
        // Re-touch `a` so it becomes the newest again.
        buffer.push(event({ kind: "counter", name: "a", value: 1 }));

        expect(buffer.entries().map((s) => s.name)).toStrictEqual(["a", "b"]);
    });

    it("evicts the least-recently-updated series at capacity", () => {
        expect.assertions(3);

        const buffer = new MetricBuffer(2);

        buffer.push(event({ kind: "counter", name: "a", value: 1 }));
        buffer.push(event({ kind: "counter", name: "b", value: 1 }));
        // Touch `a` so `b` is now the coldest, then insert `c` at capacity.
        buffer.push(event({ kind: "counter", name: "a", value: 1 }));
        buffer.push(event({ kind: "counter", name: "c", value: 1 }));

        const names = buffer.entries().map((s) => s.name);

        expect(buffer.size).toBe(2);
        expect(names).toContain("a");
        expect(names).not.toContain("b");
    });

    it("hands out fresh copies so a caller can't mutate the live aggregate", () => {
        expect.assertions(1);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "a", value: 1 }));
        // Mutating the returned snapshot must not touch the live aggregate — the
        // series exists (we just pushed it), so no defensive conditional is needed.
        const snapshot = buffer.entries()[0]!;

        snapshot.sum = 999;

        buffer.push(event({ kind: "counter", name: "a", value: 1 }));

        expect(buffer.entries()[0]?.sum).toBe(2);
    });

    it("clear() drops every series", () => {
        expect.assertions(2);

        const buffer = new MetricBuffer();

        buffer.push(event({ kind: "counter", name: "a", value: 1 }));
        buffer.clear();

        expect(buffer.size).toBe(0);
        expect(buffer.entries()).toStrictEqual([]);
    });
});
