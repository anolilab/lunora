import { describe, expect, it } from "vitest";

import { resolveTraceAnchor } from "../src/trace-context";

/**
 * The dispatch's trace anchor.
 *
 * `resolveTraceAnchor` decides two things a whole dispatch's telemetry hangs
 * off: which trace its spans belong to, and whether that trace is sampled. Both
 * have to come from the inbound `traceparent` when there is one — a shard that
 * mints its own ids strands its spans in a trace the collector has no root for,
 * and a shard that re-decides sampling produces a trace kept in the middle and
 * dropped at both ends.
 */

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";

describe("resolveTraceAnchor", () => {
    it("adopts the inbound trace and parent span so shard spans join the caller's trace", () => {
        expect.assertions(2);

        const anchor = resolveTraceAnchor(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);

        expect(anchor.traceId).toBe(TRACE_ID);
        expect(anchor.rootSpanId).toBe(PARENT_SPAN_ID);
    });

    it("inherits an inbound sampled-out verdict instead of re-deciding it", () => {
        expect.assertions(2);

        // The `00` flags octet is an upstream that already sampled this trace out.
        expect(resolveTraceAnchor(`00-${TRACE_ID}-${PARENT_SPAN_ID}-00`).sampled).toBe(false);
        expect(resolveTraceAnchor(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01`).sampled).toBe(true);
    });

    it("mints a sampled, self-contained trace when there is no inbound context", () => {
        expect.assertions(4);

        // A subscription re-run or a server-initiated call: no caller to inherit
        // from, so the shard IS the root and there is no verdict to honour.
        const anchor = resolveTraceAnchor(undefined);

        expect(anchor.sampled).toBe(true);
        expect(anchor.traceId).toHaveLength(32);
        expect(anchor.rootSpanId).toHaveLength(16);
        expect(anchor.traceId).not.toBe(resolveTraceAnchor(undefined).traceId);
    });

    it("falls back to a fresh trace when the inbound header is malformed", () => {
        expect.assertions(2);

        // A truncated trace id is not a trace we can join. Adopting it anyway
        // would emit spans under an id no other service will ever report.
        const anchor = resolveTraceAnchor("00-deadbeef-b7ad6b7169203331-01");

        expect(anchor.traceId).not.toBe("deadbeef");
        expect(anchor.traceId).toHaveLength(32);
    });
});
