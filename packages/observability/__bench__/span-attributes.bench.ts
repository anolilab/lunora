import { bench, describe } from "vitest";

import { createSpanCollector, createTracer } from "../src/context-telemetry";

/**
 * Prices the attribute path of a span: every `ctx.trace` bag, `setAttributes`
 * call, event and link runs through credential redaction on the Durable
 * Object's only thread before the span is recorded. The metrics suite covers
 * the no-attribute floor; these cases carry the attributes real handlers set.
 */
const ATTRS_3 = { "http.route": "/orders/:id", "order.id": "3f2a1c7e-9b1d-4c2a-8e2f-1a2b3c4d5e6f", plan: "pro" };

const ATTRS_20 = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`app.field_${String(index)}`, index % 3 === 0 ? index : `value-${String(index)} for the order`]),
);

const anchor = { rootSpanId: "root0000root0000", traceId: "0af7651916cd43dd8448eb211c80319c" };

const trace = createTracer({ anchor, functionPath: "orders:get", record: () => undefined, shardKey: "shard-1", userId: () => "user-1" });

describe("span attributes — redaction cost", () => {
    bench("ctx.trace, 3 attributes", async () => {
        await trace("load", () => undefined, ATTRS_3);
    });

    bench("ctx.trace, 20 attributes", async () => {
        await trace("load", () => undefined, ATTRS_20);
    });

    bench("addEvent, 3 attributes", () => {
        createSpanCollector({ spanId: "span000000000001", traceId: anchor.traceId }).handle.addEvent("retry", ATTRS_3);
    });
});
