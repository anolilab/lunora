import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { filterTraces, formatSpanDuration, spanBar } from "../../../src/features/traces/trace-geometry";
import { TracesPanel } from "../../../src/features/traces/traces-panel";
import type { TraceSpan, TraceSummary } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/** A root span plus two nested children — the shape `foldTraces` emits. */
const SEND_SPANS: TraceSpan[] = [
    { depth: 0, durationMs: 100, name: "messages:send", offsetMs: 0, ok: true, parentSpanId: "", spanId: "s0" },
    {
        attributes: { orderId: "o-1" },
        depth: 1,
        durationMs: 40,
        name: "stripe.charge",
        offsetMs: 10,
        ok: true,
        parentSpanId: "s0",
        spanId: "s1",
    },
    { depth: 2, durationMs: 25, name: "db.insert", offsetMs: 60, ok: true, parentSpanId: "s1", spanId: "s2" },
];

const LIST_SPANS: TraceSpan[] = [{ depth: 0, durationMs: 8, name: "messages:list", offsetMs: 0, ok: true, parentSpanId: "", spanId: "l0" }];

const TRACES: TraceSummary[] = [
    {
        durationMs: 100,
        functionPath: "messages:send",
        ok: true,
        rootName: "messages:send",
        shardKey: "room-9",
        spans: SEND_SPANS,
        startTs: 1_700_000_002_000,
        traceId: "trace-send",
    },
    {
        durationMs: 8,
        functionPath: "messages:list",
        ok: true,
        rootName: "messages:list",
        spans: LIST_SPANS,
        startTs: 1_700_000_001_000,
        traceId: "trace-list",
    },
];

/** A trace whose root span threw — drives the error indicator + message. */
const ERROR_TRACE: TraceSummary = {
    durationMs: 50,
    functionPath: "billing:charge",
    ok: false,
    rootName: "billing:charge",
    spans: [
        { depth: 0, durationMs: 50, name: "billing:charge", offsetMs: 0, ok: true, parentSpanId: "", spanId: "e0" },
        {
            depth: 1,
            durationMs: 30,
            error: { message: "card declined", type: "StripeError" },
            name: "stripe.charge",
            offsetMs: 5,
            ok: false,
            parentSpanId: "e0",
            spanId: "e1",
        },
    ],
    startTs: 1_700_000_003_000,
    traceId: "trace-error",
};

/**
 * A whole trace that settled inside one wall-clock millisecond — routine on a
 * Durable Object, whose clock only advances on I/O — so `durationMs` folds to 0
 * and becomes a division-by-zero denominator.
 */
const ZERO_TRACE: TraceSummary = {
    durationMs: 0,
    functionPath: "health:ping",
    ok: true,
    rootName: "health:ping",
    spans: [
        { depth: 0, durationMs: 0, name: "health:ping", offsetMs: 0, ok: true, parentSpanId: "", spanId: "z0" },
        { depth: 1, durationMs: 0, name: "cache.get", offsetMs: 0, ok: true, parentSpanId: "z0", spanId: "z1" },
    ],
    startTs: 1_700_000_004_000,
    traceId: "trace-zero",
};

const createClient = (traces: TraceSummary[] = TRACES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getTraces) {
                return { traces };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <TracesPanel />
    </LunoraProvider>
);

describe("tracesPanel", () => {
    it("renders one row per recent trace with its path, duration, span count, and status", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        const row = await screen.findByTestId("tr-row-trace-send");

        expect(row.textContent).toContain("messages:send");
        expect(row.textContent).toContain("100ms");
        expect(row.textContent).toContain("3 spans");
        expect(screen.getByTestId("tr-row-trace-list")).toBeTruthy();
    });

    it("renders the empty state when the shard's span ring holds no traces", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        expect(await screen.findByTestId("tr-empty")).toBeTruthy();
    });

    it("keeps waterfalls collapsed until a trace is selected", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await screen.findByTestId("tr-row-trace-send");

        expect(screen.queryByTestId("tr-waterfall-trace-send")).toBeNull();
        expect(screen.queryAllByTestId("tr-span-row")).toHaveLength(0);
    });

    it("expands a trace into one waterfall row per span, indented by depth", async () => {
        expect.assertions(5);

        render(renderPanel(createClient()));

        fireEvent.click(await screen.findByTestId("tr-toggle-trace-send"));

        const rows = await screen.findAllByTestId("tr-span-row");

        expect(rows).toHaveLength(3);
        expect(rows[0]?.textContent).toContain("messages:send");
        // Indent is driven purely by the server-computed `depth` — no tree math.
        expect(rows[0]?.dataset.depth).toBe("0");
        expect(rows[1]?.dataset.depth).toBe("1");
        expect(rows[2]?.dataset.depth).toBe("2");
    });

    it("positions each span bar from offsetMs and sizes it from durationMs", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        fireEvent.click(await screen.findByTestId("tr-toggle-trace-send"));

        const bars = await screen.findAllByTestId("tr-span-bar");

        // Trace duration is 100ms, so each ms is exactly 1%.
        expect(bars[0]?.style.left).toBe("0%");
        expect(bars[0]?.style.width).toBe("100%");
        expect(bars[1]?.style.left).toBe("10%");
        expect(bars[1]?.style.width).toBe("40%");
    });

    it("renders a span's structured attributes with the shared field formatter", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        fireEvent.click(await screen.findByTestId("tr-toggle-trace-send"));

        const attributes = await screen.findByTestId("tr-span-attributes");

        expect(attributes.textContent).toBe("orderId=o-1");
    });

    it("marks an errored span with an indicator and its error message", async () => {
        expect.assertions(3);

        render(renderPanel(createClient([ERROR_TRACE])));

        fireEvent.click(await screen.findByTestId("tr-toggle-trace-error"));

        const indicators = await screen.findAllByTestId("tr-span-error");
        const message = screen.getByTestId("tr-span-error-message");

        // Only the failing child carries the indicator; its ok parent does not.
        expect(indicators).toHaveLength(1);
        expect(message.textContent).toContain("card declined");
        expect(message.textContent).toContain("StripeError");
    });

    it("renders visible bars for a zero-duration trace rather than NaN", async () => {
        expect.assertions(3);

        render(renderPanel(createClient([ZERO_TRACE])));

        fireEvent.click(await screen.findByTestId("tr-toggle-trace-zero"));

        const bars = await screen.findAllByTestId("tr-span-bar");

        expect(bars).toHaveLength(2);

        for (const bar of bars) {
            expect(bar.style.width).toBe("100%");
        }
    });

    it("narrows the trace list to matches of the debounced search term", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await screen.findByTestId("tr-row-trace-send");

        fireEvent.change(screen.getByTestId("tr-search"), { target: { value: "list" } });

        await waitFor(() => {
            if (screen.queryByTestId("tr-row-trace-send") !== null) {
                throw new Error("not filtered yet");
            }
        });

        expect(screen.queryByTestId("tr-row-trace-send")).toBeNull();
        expect(screen.getByTestId("tr-row-trace-list")).toBeTruthy();
    });

    it("re-reads against a debounced shard-key change", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("tr-list");

        fireEvent.change(screen.getByTestId("tr-shard-input"), { target: { value: "room-9" } });

        await waitFor(() => {
            const last = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }] | undefined;

            if (last?.[2]?.shardKey !== "room-9") {
                throw new Error("not re-seeded yet");
            }
        });

        const lastCall = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastCall[2]).toEqual({ shardKey: "room-9" });
    });
});

describe("spanBar", () => {
    const span = (offsetMs: number, durationMs: number): TraceSpan => ({
        depth: 0,
        durationMs,
        name: "s",
        offsetMs,
        ok: true,
        parentSpanId: "",
        spanId: "s",
    });

    it("converts offset and duration into percentages of the trace duration", () => {
        expect.assertions(1);

        expect(spanBar(span(25, 50), 200)).toStrictEqual({ leftPercent: 12.5, widthPercent: 25 });
    });

    it("lays a zero-duration trace out full-width instead of dividing by zero", () => {
        expect.assertions(2);

        const bar = spanBar(span(0, 0), 0);

        expect(bar).toStrictEqual({ leftPercent: 0, widthPercent: 100 });
        expect(Number.isNaN(bar.widthPercent)).toBe(false);
    });

    it("keeps a sub-millisecond span visible with a minimum bar width", () => {
        expect.assertions(2);

        const bar = spanBar(span(500, 0), 1000);

        expect(bar.leftPercent).toBe(50);
        expect(bar.widthPercent).toBeGreaterThan(0);
    });

    it("clips a bar that would overflow the right edge of its track", () => {
        expect.assertions(1);

        // A partial trace's surviving anchor can leave a child ending past the
        // trace end; the bar must stop at the track edge rather than overflow.
        expect(spanBar(span(80, 60), 100)).toStrictEqual({ leftPercent: 80, widthPercent: 20 });
    });

    it("degrades to full-width bars for a non-finite trace duration", () => {
        expect.assertions(1);

        expect(spanBar(span(0, 10), Number.NaN)).toStrictEqual({ leftPercent: 0, widthPercent: 100 });
    });
});

describe("filterTraces", () => {
    it("returns every trace for an empty or whitespace-only term", () => {
        expect.assertions(2);

        expect(filterTraces(TRACES, "")).toHaveLength(2);
        expect(filterTraces(TRACES, "   ")).toHaveLength(2);
    });

    it("matches the root name and the function path case-insensitively", () => {
        expect.assertions(2);

        expect(filterTraces(TRACES, "LIST").map((trace) => trace.traceId)).toStrictEqual(["trace-list"]);
        expect(filterTraces(TRACES, "messages:")).toHaveLength(2);
    });

    it("yields an empty list when nothing matches", () => {
        expect.assertions(1);

        expect(filterTraces(TRACES, "nope")).toStrictEqual([]);
    });
});

describe("formatSpanDuration", () => {
    it("rounds a millisecond-or-longer duration to a whole millisecond", () => {
        expect.assertions(2);

        expect(formatSpanDuration(12.4)).toBe("12ms");
        expect(formatSpanDuration(0)).toBe("0ms");
    });

    it("keeps two decimals for a sub-millisecond span so it does not read as zero", () => {
        expect.assertions(1);

        expect(formatSpanDuration(0.4)).toBe("0.40ms");
    });
});
