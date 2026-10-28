import { bench, describe } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import { SpanBuffer } from "../src/span-buffer";

/*
 * Every Durable Object dispatch asks `hasTrace` whether it recorded any span
 * before deciding to record a root span, and the common handler records none:
 * a miss against a full ring. `push` runs once per recorded span.
 */

const traceId = (index: number): string => index.toString(16).padStart(32, "0");

// One string per trace, built up front: a dispatch's spans share its anchor's traceId.
const TRACE_IDS = Array.from({ length: 1000 }, (_, index) => traceId(index));

/** Five spans per trace: a dispatch usually records a few. */
const span = (index: number): SpanEvent => {
    return {
        durationMs: 1,
        functionPath: "orders:get",
        name: "db.query",
        ok: true,
        parentSpanId: "root0000root0000",
        spanId: index.toString(16).padStart(16, "0"),
        startTs: index,
        traceId: TRACE_IDS[Math.floor(index / 5) % TRACE_IDS.length] as string,
    };
};

const full = new SpanBuffer();

for (let index = 0; index < 500; index += 1) {
    full.push(span(index));
}

let next = 500;

const MISSING_TRACE_ID = traceId(1_000_000);

describe("SpanBuffer (full ring of 500)", () => {
    bench("hasTrace miss", () => {
        full.hasTrace(MISSING_TRACE_ID);
    });

    bench("push (evicts the oldest)", () => {
        full.push(span(next));
        next += 1;
    });
});
