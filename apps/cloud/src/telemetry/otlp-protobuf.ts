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

/** The 32-bit place value used to reassemble a 64-bit field from its two halves. */
const TWO_POW_32 = 2n ** 32n;

/** Lower-hex encode raw id bytes (OTLP carries trace/span ids as bytes; the decoders expect hex). */
const toHex = (bytes: Uint8Array): string => {
    let out = "";

    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
};

/**
 * A minimal, allocation-light protobuf reader over a byte view. Reads only the
 * wire primitives the OTLP messages use; `skip` discards a field this decoder
 * doesn't care about so the walk never desyncs.
 */
class Reader {
    public pos = 0;

    private readonly view: DataView;

    public constructor(private readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    public get eof(): boolean {
        return this.pos >= this.bytes.length;
    }

    /**
     * Read a base-128 varint as a BigInt (safe for 64-bit ints/tags). Capped at
     * 10 bytes (a 64-bit varint's max): an unterminated/oversized varint throws
     * rather than consuming the whole buffer — otherwise an adversarial all-`0xFF`
     * body drives O(n²) BigInt work (a CPU-exhaustion DoS on the shared isolate).
     * The route's decode `try/catch` turns the throw into a 400.
     */
    public varint(): bigint {
        let result = 0n;
        let shift = 0n;
        let byte: number;
        let read = 0;

        do {
            if (this.pos >= this.bytes.length || read >= 10) {
                throw new Error("malformed OTLP protobuf: varint overflows 64 bits or runs past end");
            }

            byte = this.bytes[this.pos];
            this.pos += 1;
            read += 1;
            // Each group occupies its own 7 bits, so `+` is exact here — no
            // group can carry into the next.
            result += BigInt(byte % 0x80) * 2n ** shift;
            shift += 7n;
            // The high bit is the continuation flag.
        } while (byte >= 0x80);

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

        return (hi * TWO_POW_32 + lo).toString();
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

        // `hi` is signed here, which is what makes this the SIGNED reassembly.
        return (hi * TWO_POW_32 + lo).toString();
    }

    /** A length-delimited byte slice. */
    public readBytes(): Uint8Array {
        const length = Number(this.varint());
        const slice = this.bytes.subarray(this.pos, this.pos + length);
        this.pos += length;

        return slice;
    }

    /** A length-delimited UTF-8 string. */
    public string(): string {
        return new TextDecoder().decode(this.readBytes());
    }

    /** A sub-reader over the next length-delimited message. */
    public message(): Reader {
        return new Reader(this.readBytes());
    }

    /** Discard a field of the given wire type (unknown/uninteresting fields). */
    public skip(wireType: number): void {
        switch (wireType) {
            case WIRE_FIXED32: {
                this.pos += 4;

                break;
            }
            case WIRE_FIXED64: {
                this.pos += 8;

                break;
            }
            case WIRE_LEN: {
                this.pos += Number(this.varint());

                break;
            }
            case WIRE_VARINT: {
                this.varint();

                break;
            }
            default: {
                // An unrecognised wire type carries no length information, so
                // there is nothing to skip deterministically. Leave `pos` alone
                // and let the caller's bounds checks end the walk.
                break;
            }
        }
    }
}

/** Walk every `(fieldNumber, wireType)` in a message, calling `onField`; auto-skips fields it doesn't handle. */
const eachField = (reader: Reader, onField: (fieldNumber: number, wireType: number) => boolean): void => {
    while (!reader.eof) {
        const tag = reader.varintNumber();
        const fieldNumber = Math.floor(tag / 8);
        const wireType = tag % 8;

        if (!onField(fieldNumber, wireType)) {
            reader.skip(wireType);
        }
    }
};

type AnyValue = { boolValue?: boolean; doubleValue?: number; intValue?: string; stringValue?: string };
type KeyValue = { key: string; value?: AnyValue };

/** Reads a `common.v1.AnyValue` — only the scalar variants the decoders read. */
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

/** Reads a `common.v1.KeyValue`. */
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

const readSpan = (reader: Reader): SpanOut => {
    const span: SpanOut = { attributes: [] };

    // Two halves of one flat wire-format dispatch, written as closures over
    // `span` so each stays small and neither takes the row as a parameter it
    // would then mutate. The wire-type guard on every arm is load-bearing: a
    // field whose wire type doesn't match is left unhandled, so `eachField`
    // skips it and the walk stays in sync.
    const readIdentity = (field: number, wire: number): boolean => {
        if (field === 1 && wire === WIRE_LEN) {
            span.traceId = toHex(reader.readBytes());
        } else if (field === 2 && wire === WIRE_LEN) {
            span.spanId = toHex(reader.readBytes());
        } else if (field === 4 && wire === WIRE_LEN) {
            span.parentSpanId = toHex(reader.readBytes());
        } else if (field === 5 && wire === WIRE_LEN) {
            span.name = reader.string();
        } else {
            return false;
        }

        return true;
    };

    const readBody = (field: number, wire: number): boolean => {
        if (field === 7 && wire === WIRE_FIXED64) {
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
    };

    eachField(reader, (field, wire) => readIdentity(field, wire) || readBody(field, wire));

    return span;
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

/**
 * A `ResourceX` message (`ResourceSpans`/`ResourceLogs`/`ResourceMetrics`): field 1
 * is the resource (attributes), field 2 the repeated `scopeX` child. Identical
 * across all three signals — parameterized by the output key + the child reader.
 */
const readResourceEnvelope = (reader: Reader, scopeKey: string, readScopeChild: (reader: Reader) => unknown): Record<string, unknown> => {
    const children: unknown[] = [];
    const entry: Record<string, unknown> = { [scopeKey]: children };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.resource = { attributes: readAttributes(reader.message(), 1) };

            return true;
        }

        if (field === 2 && wire === WIRE_LEN) {
            children.push(readScopeChild(reader.message()));

            return true;
        }

        return false;
    });

    return entry;
};

/**
 * A `ScopeX` message (`ScopeSpans`/`ScopeLogs`/`ScopeMetrics`): field 1 is the
 * instrumentation scope, field 2 the repeated item (span/log/metric). Identical
 * across all three signals — parameterized by the item key + the item reader.
 */
const readScopeEnvelope = (reader: Reader, itemKey: string, readItem: (reader: Reader) => unknown): Record<string, unknown> => {
    const items: unknown[] = [];
    const entry: Record<string, unknown> = { [itemKey]: items };

    eachField(reader, (field, wire) => {
        if (field === 1 && wire === WIRE_LEN) {
            entry.scope = readScope(reader.message());

            return true;
        }

        if (field === 2 && wire === WIRE_LEN) {
            items.push(readItem(reader.message()));

            return true;
        }

        return false;
    });

    return entry;
};

// ── Logs ────────────────────────────────────────────────────────────────────

const readScopeSpans = (reader: Reader): Record<string, unknown> => readScopeEnvelope(reader, "spans", readSpan);

const readResourceSpans = (reader: Reader): Record<string, unknown> => readResourceEnvelope(reader, "scopeSpans", readScopeSpans);

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
            record.traceId = toHex(reader.readBytes());
        } else if (field === 10 && wire === WIRE_LEN) {
            record.spanId = toHex(reader.readBytes());
        } else {
            return false;
        }

        return true;
    });

    return record;
};

const readScopeLogs = (reader: Reader): Record<string, unknown> => readScopeEnvelope(reader, "logRecords", readLogRecord);

const readResourceLogs = (reader: Reader): Record<string, unknown> => readResourceEnvelope(reader, "scopeLogs", readScopeLogs);

/** Decode an OTLP/protobuf `ExportLogsService` request into the JSON payload shape. */
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

const readScopeMetrics = (reader: Reader): Record<string, unknown> => readScopeEnvelope(reader, "metrics", readMetric);

const readResourceMetrics = (reader: Reader): Record<string, unknown> => readResourceEnvelope(reader, "scopeMetrics", readScopeMetrics);

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
