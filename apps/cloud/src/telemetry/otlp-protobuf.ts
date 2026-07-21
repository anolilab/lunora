/**
 * OTLP/protobuf decode for the standard ingest (`/v1/traces`, `/v1/logs`,
 * `/v1/metrics`). Real OpenTelemetry Collectors default to `application/x-protobuf`,
 * so JSON-only ingest turns most zero-config Collector setups away.
 *
 * This is a **hand-rolled, Worker-safe** protobuf wire decoder — `protobufjs`
 * (the obvious dependency) generates its decoders with `new Function`, which the
 * Workers runtime blocks, so it can't run in the dispatcher. Rather than vendor a
 * statically-generated codec, we decode the small, fixed slice of the OTLP
 * messages the ingest actually reads directly off the wire (no `eval`, no
 * dependency). The output mirrors the JSON payload shapes in `./otlp`
 * (`OtlpTracePayload`/`OtlpLogsPayload`/`OtlpMetricsPayload`), so the same
 * `decode*` functions consume both transports unchanged.
 *
 * Field numbers follow opentelemetry-proto (trace/logs/metrics/common v1).
 */
import type { OtlpLogsPayload, OtlpMetricsPayload, OtlpTracePayload } from "./otlp";

/** Protobuf wire types. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

const HEX = "0123456789abcdef";

/** Lower-hex encode raw id bytes (OTLP carries trace/span ids as bytes; the decoders expect hex). */
const toHex = (bytes: Uint8Array): string => {
    let out = "";

    for (const byte of bytes) {
        out += HEX[byte >> 4] + HEX[byte & 0x0f];
    }

    return out;
};

/**
 * A minimal, allocation-light protobuf reader over a byte view. Reads only the
 * wire primitives the OTLP messages use; `skip` discards a field this decoder
 * doesn't care about so the walk never desyncs.
 */
class Reader {
    private readonly view: DataView;

    public pos = 0;

    public constructor(private readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    public get eof(): boolean {
        return this.pos >= this.bytes.length;
    }

    /** Read a base-128 varint as a BigInt (safe for 64-bit ints/tags). */
    public varint(): bigint {
        let result = 0n;
        let shift = 0n;
        let byte = 0;

        do {
            byte = this.bytes[this.pos] ?? 0;
            this.pos += 1;
            result |= BigInt(byte & 0x7f) << shift;
            shift += 7n;
        } while ((byte & 0x80) !== 0 && this.pos < this.bytes.length);

        return result;
    }

    /** A varint small enough to be a tag / field number / enum — as a Number. */
    public varintNumber(): number {
        return Number(this.varint());
    }

    /** 8 LE bytes as an unsigned decimal string (OTLP `fixed64` times). */
    public fixed64String(): string {
        const lo = BigInt(this.view.getUint32(this.pos, true));
        const hi = BigInt(this.view.getUint32(this.pos + 4, true));
        this.pos += 8;

        return ((hi << 32n) | lo).toString();
    }

    /** 8 LE bytes as an IEEE-754 double (OTLP `double` / `as_double`). */
    public double(): number {
        const value = this.view.getFloat64(this.pos, true);
        this.pos += 8;

        return value;
    }

    /** 8 LE bytes as a signed decimal string (OTLP `sfixed64` / `as_int`). */
    public sfixed64String(): string {
        const lo = BigInt(this.view.getUint32(this.pos, true));
        const hi = BigInt(this.view.getInt32(this.pos + 4, true));
        this.pos += 8;

        return ((hi << 32n) | lo).toString();
    }

    /** A length-delimited byte slice. */
    public bytes_(): Uint8Array {
        const length = Number(this.varint());
        const slice = this.bytes.subarray(this.pos, this.pos + length);
        this.pos += length;

        return slice;
    }

    /** A length-delimited UTF-8 string. */
    public string(): string {
        return new TextDecoder().decode(this.bytes_());
    }

    /** A sub-reader over the next length-delimited message. */
    public message(): Reader {
        return new Reader(this.bytes_());
    }

    /** Discard a field of the given wire type (unknown/uninteresting fields). */
    public skip(wireType: number): void {
        if (wireType === WIRE_VARINT) {
            this.varint();
        } else if (wireType === WIRE_FIXED64) {
            this.pos += 8;
        } else if (wireType === WIRE_LEN) {
            this.pos += Number(this.varint());
        } else if (wireType === WIRE_FIXED32) {
            this.pos += 4;
        }
    }
}

/** Walk every `(fieldNumber, wireType)` in a message, calling `onField`; auto-skips fields it doesn't handle. */
const eachField = (reader: Reader, onField: (fieldNumber: number, wireType: number) => boolean): void => {
    while (!reader.eof) {
        const tag = reader.varintNumber();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x07;

        if (!onField(fieldNumber, wireType)) {
            reader.skip(wireType);
        }
    }
};

type AnyValue = { boolValue?: boolean; doubleValue?: number; intValue?: string; stringValue?: string };
type KeyValue = { key: string; value?: AnyValue };

/** common.v1.AnyValue — only the scalar variants the decoders read. */
const readAnyValue = (reader: Reader): AnyValue => {
    const value: AnyValue = {};

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            value.stringValue = reader.string();
        } else if (field === 2 && wire === WIRE_VARINT) {
            value.boolValue = reader.varint() !== 0n;
        } else if (field === 3 && wire === WIRE_VARINT) {
            value.intValue = reader.varint().toString();
        } else if (field === 4 && wire === WIRE_FIXED64) {
            value.doubleValue = reader.double();
        } else {
            return false;
        }

        return true;
    });

    return value;
};

/** common.v1.KeyValue. */
const readKeyValue = (reader: Reader): KeyValue => {
    const entry: KeyValue = { key: "" };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.key = reader.string();
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.value = readAnyValue(reader.message());
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

/** A `{ attributes: [] }`-carrying message: collect repeated KeyValue at `field`. */
const readAttributes = (reader: Reader, attributeField: number): KeyValue[] => {
    const attributes: KeyValue[] = [];

    eachField(reader, (field, wire) => {
        if (field === attributeField && wire === WIRE_LEN) {
            attributes.push(readKeyValue(reader.message()));

            return true;
        }

        return false;
    });

    return attributes;
};

// ── Traces ──────────────────────────────────────────────────────────────────

/** One decoded span, shaped like the JSON `OtlpSpan` the trace decoders read. */
interface SpanOut {
    attributes: KeyValue[];
    endTimeUnixNano?: string;
    name?: string;
    parentSpanId?: string;
    spanId?: string;
    startTimeUnixNano?: string;
    status?: { code?: number; message?: string };
    traceId?: string;
}

const readSpan = (reader: Reader): SpanOut => {
    const span: SpanOut = { attributes: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            span.traceId = toHex(reader.bytes_());
        } else if (field === 2 && wire === WIRE_LEN) {
            span.spanId = toHex(reader.bytes_());
        } else if (field === 4 && wire === WIRE_LEN) {
            span.parentSpanId = toHex(reader.bytes_());
        } else if (field === 5 && wire === WIRE_LEN) {
            span.name = reader.string();
        } else if (field === 7 && wire === WIRE_FIXED64) {
            span.startTimeUnixNano = reader.fixed64String();
        } else if (field === 8 && wire === WIRE_FIXED64) {
            span.endTimeUnixNano = reader.fixed64String();
        } else if (field === 9 && wire === WIRE_LEN) {
            span.attributes.push(readKeyValue(reader.message()));
        } else if (field === 15 && wire === WIRE_LEN) {
            span.status = readStatus(reader.message());
        } else {
            return false;
        }

        return true;
    });

    return span;
};

const readStatus = (reader: Reader): { code?: number; message?: string } => {
    const status: { code?: number; message?: string } = {};

    eachField(reader, (field, wire) => {
        if (field === 2 && wire === WIRE_LEN) {
            status.message = reader.string();
        } else if (field === 3 && wire === WIRE_VARINT) {
            status.code = reader.varintNumber();
        } else {
            return false;
        }

        return true;
    });

    return status;
};

/** Decode an OTLP/protobuf `ExportTraceServiceRequest` into the JSON payload shape. */
export const decodeTracePayloadProto = (bytes: Uint8Array): OtlpTracePayload => {
    const resourceSpans: unknown[] = [];
    const root = new Reader(bytes);

    eachField(root, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            resourceSpans.push(readResourceSpans(root.message()));

            return true;
        }

        return false;
    });

    return { resourceSpans } as OtlpTracePayload;
};

const readResourceSpans = (reader: Reader): Record<string, unknown> => {
    const entry: { resource?: { attributes: KeyValue[] }; scopeSpans: unknown[] } = { scopeSpans: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.resource = { attributes: readAttributes(reader.message(), 1) };
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.scopeSpans.push(readScopeSpans(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

const readScopeSpans = (reader: Reader): Record<string, unknown> => {
    const entry: { scope?: { name?: string }; spans: unknown[] } = { spans: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.scope = readScope(reader.message());
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.spans.push(readSpan(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

const readScope = (reader: Reader): { name?: string } => {
    const scope: { name?: string } = {};

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            scope.name = reader.string();

            return true;
        }

        return false;
    });

    return scope;
};

// ── Logs ────────────────────────────────────────────────────────────────────

const readLogRecord = (reader: Reader): Record<string, unknown> => {
    const record: Record<string, unknown> = { attributes: [] as KeyValue[] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_FIXED64) {
            record.timeUnixNano = reader.fixed64String();
        } else if (field === 2 && wire === WIRE_VARINT) {
            record.severityNumber = reader.varintNumber();
        } else if (field === 3 && wire === WIRE_LEN) {
            record.severityText = reader.string();
        } else if (field === 5 && wire === WIRE_LEN) {
            record.body = readAnyValue(reader.message());
        } else if (field === 6 && wire === WIRE_LEN) {
            (record.attributes as KeyValue[]).push(readKeyValue(reader.message()));
        } else if (field === 9 && wire === WIRE_LEN) {
            record.traceId = toHex(reader.bytes_());
        } else if (field === 10 && wire === WIRE_LEN) {
            record.spanId = toHex(reader.bytes_());
        } else {
            return false;
        }

        return true;
    });

    return record;
};

const readScopeLogs = (reader: Reader): Record<string, unknown> => {
    const entry: { logRecords: unknown[]; scope?: { name?: string } } = { logRecords: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.scope = readScope(reader.message());
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.logRecords.push(readLogRecord(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

const readResourceLogs = (reader: Reader): Record<string, unknown> => {
    const entry: { resource?: { attributes: KeyValue[] }; scopeLogs: unknown[] } = { scopeLogs: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.resource = { attributes: readAttributes(reader.message(), 1) };
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.scopeLogs.push(readScopeLogs(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

/** Decode an OTLP/protobuf `ExportLogsServiceRequest` into the JSON payload shape. */
export const decodeLogsPayloadProto = (bytes: Uint8Array): OtlpLogsPayload => {
    const resourceLogs: unknown[] = [];
    const root = new Reader(bytes);

    eachField(root, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            resourceLogs.push(readResourceLogs(root.message()));

            return true;
        }

        return false;
    });

    return { resourceLogs } as OtlpLogsPayload;
};

// ── Metrics ─────────────────────────────────────────────────────────────────

const readNumberDataPoint = (reader: Reader): Record<string, unknown> => {
    const point: Record<string, unknown> = { attributes: [] as KeyValue[] };

    eachField(reader, (field, wire) => {
        if (field === 7 && wire === WIRE_LEN) {
            (point.attributes as KeyValue[]).push(readKeyValue(reader.message()));
        } else if (field === 3 && wire === WIRE_FIXED64) {
            point.timeUnixNano = reader.fixed64String();
        } else if (field === 4 && wire === WIRE_FIXED64) {
            point.asDouble = reader.double();
        } else if (field === 6 && wire === WIRE_FIXED64) {
            point.asInt = reader.sfixed64String();
        } else {
            return false;
        }

        return true;
    });

    return point;
};

const readHistogramDataPoint = (reader: Reader): Record<string, unknown> => {
    const point: Record<string, unknown> = { attributes: [] as KeyValue[] };

    eachField(reader, (field, wire) => {
        if (field === 9 && wire === WIRE_LEN) {
            (point.attributes as KeyValue[]).push(readKeyValue(reader.message()));
        } else if (field === 3 && wire === WIRE_FIXED64) {
            point.timeUnixNano = reader.fixed64String();
        } else if (field === 5 && wire === WIRE_FIXED64) {
            point.sum = reader.double();
        } else {
            return false;
        }

        return true;
    });

    return point;
};

const readDataPoints = (reader: Reader, readPoint: (r: Reader) => Record<string, unknown>): { dataPoints: unknown[] } => {
    const points: unknown[] = [];

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            points.push(readPoint(reader.message()));

            return true;
        }

        return false;
    });

    return { dataPoints: points };
};

const readMetric = (reader: Reader): Record<string, unknown> => {
    const metric: Record<string, unknown> = {};

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            metric.name = reader.string();
        } else if (field === 5 && wire === WIRE_LEN) {
            metric.gauge = readDataPoints(reader.message(), readNumberDataPoint);
        } else if (field === 7 && wire === WIRE_LEN) {
            metric.sum = readDataPoints(reader.message(), readNumberDataPoint);
        } else if (field === 9 && wire === WIRE_LEN) {
            metric.histogram = readDataPoints(reader.message(), readHistogramDataPoint);
        } else {
            return false;
        }

        return true;
    });

    return metric;
};

const readScopeMetrics = (reader: Reader): Record<string, unknown> => {
    const entry: { metrics: unknown[]; scope?: { name?: string } } = { metrics: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.scope = readScope(reader.message());
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.metrics.push(readMetric(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

const readResourceMetrics = (reader: Reader): Record<string, unknown> => {
    const entry: { resource?: { attributes: KeyValue[] }; scopeMetrics: unknown[] } = { scopeMetrics: [] };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.resource = { attributes: readAttributes(reader.message(), 1) };
        } else if (field === 2 && wire === WIRE_LEN) {
            entry.scopeMetrics.push(readScopeMetrics(reader.message()));
        } else {
            return false;
        }

        return true;
    });

    return entry;
};

/** Decode an OTLP/protobuf `ExportMetricsServiceRequest` into the JSON payload shape. */
export const decodeMetricsPayloadProto = (bytes: Uint8Array): OtlpMetricsPayload => {
    const resourceMetrics: unknown[] = [];
    const root = new Reader(bytes);

    eachField(root, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            resourceMetrics.push(readResourceMetrics(root.message()));

            return true;
        }

        return false;
    });

    return { resourceMetrics } as OtlpMetricsPayload;
};
