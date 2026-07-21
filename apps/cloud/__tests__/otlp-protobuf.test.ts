import { describe, expect, it } from "vitest";

import { decodeMetricPoints, decodeObservations } from "../src/telemetry/otlp";
import { decodeMetricsPayloadProto, decodeTracePayloadProto } from "../src/telemetry/otlp-protobuf";

// ── A minimal protobuf encoder, just enough to build OTLP fixtures ────────────

const varint = (value: number): number[] => {
    const out: number[] = [];
    let remaining = value;

    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);

        if (remaining > 0) {
            byte |= 0x80;
        }

        out.push(byte);
    } while (remaining > 0);

    return out;
};

const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);

/** Length-delimited (wire 2): tag, length, bytes. */
const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes];

const stringField = (field: number, value: string): number[] => lenField(field, [...new TextEncoder().encode(value)]);

const varintField = (field: number, value: number): number[] => [...tag(field, 0), ...varint(value)];

const fixed64Field = (field: number, value: bigint): number[] => {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setBigUint64(0, value, true);

    return [...tag(field, 1), ...buffer];
};

const doubleField = (field: number, value: number): number[] => {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setFloat64(0, value, true);

    return [...tag(field, 1), ...buffer];
};

/** A KeyValue with a string AnyValue. */
const stringAttribute = (key: string, value: string): number[] => lenField(9, [...stringField(1, key), ...lenField(2, stringField(1, value))]);

describe(decodeTracePayloadProto, () => {
    it("round-trips a worker span through the wire decoder into an observation", () => {
        const traceId = Array.from({ length: 16 }, (_unused, index) => index + 1); // 0102…10
        const spanId = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];

        const span = [
            ...lenField(1, traceId), // trace_id (bytes)
            ...lenField(2, spanId), // span_id (bytes)
            ...stringField(5, "messages:send"), // name
            ...fixed64Field(7, 1_700_000_000_000_000_000n), // start_time_unix_nano
            ...fixed64Field(8, 1_700_000_000_100_000_000n), // end_time_unix_nano
            ...stringAttribute("lunora.function_path", "messages:send"),
            ...lenField(15, varintField(3, 1)), // status { code = 1 }
        ];

        const scopeSpans = [...lenField(1, stringField(1, "@lunora/runtime")), ...lenField(2, span)];
        const resourceSpans = [...lenField(2, scopeSpans)];
        const payload = new Uint8Array(lenField(1, resourceSpans));

        const decoded = decodeTracePayloadProto(payload);
        const [observation] = decodeObservations(decoded);

        expect(observation).toMatchObject({
            durationMs: 100,
            endedAt: 1_700_000_000_100,
            functionPath: "messages:send",
            kind: "worker",
            level: "info",
            spanId: "aabbccdd11223344",
            startedAt: 1_700_000_000_000,
            traceId: "0102030405060708090a0b0c0d0e0f10",
        });
    });
});

describe(decodeMetricsPayloadProto, () => {
    it("round-trips a sum metric through the wire decoder into a metric point", () => {
        // NumberDataPoint { as_double = 4 (fixed64 double), time_unix_nano = 3 }
        const dataPoint = [...doubleField(4, 42.5), ...fixed64Field(3, 1_700_000_000_000_000_000n)];
        // Sum { data_points = 1 }
        const sum = lenField(1, dataPoint);
        // Metric { name = 1, sum = 7 }
        const metric = [...stringField(1, "queue.depth"), ...lenField(7, sum)];
        const scopeMetrics = lenField(2, metric);
        const resourceMetrics = lenField(2, scopeMetrics);
        const payload = new Uint8Array(lenField(1, resourceMetrics));

        const [point] = decodeMetricPoints(decodeMetricsPayloadProto(payload));

        expect(point).toMatchObject({ kind: "sum", name: "queue.depth", value: 42.5 });
    });
});
