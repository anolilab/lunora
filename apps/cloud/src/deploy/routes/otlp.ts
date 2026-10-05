/**
 * The standard OTLP ingest endpoints — `POST /v1/traces`, `/v1/logs`,
 * `/v1/metrics`.
 *
 * Split out of `router.ts` because it is a coherent sub-domain whose imports
 * nothing else in that file used: the wire decoders, the two protobuf decoders
 * and the telemetry store factory were pulled in for these three routes alone.
 * Its coupling back to the router is only the shared primitives in `./shared`,
 * which is why those had to move first — importing them from `router.ts` would
 * be circular, since the router imports these handlers.
 *
 * These serve STOCK third-party OpenTelemetry collectors, which explains the
 * behaviour that looks unusual beside the rest of the app: a deliberately
 * lenient bearer parse (some exporters send a bare token), a hard
 * decompressed-body ceiling against a gzip bomb, and `rejected`'s status mapping
 * rather than a blanket 500 — a collector treats 5xx as non-retryable and drops
 * the batch, so answering 500 to a throttle loses a tenant's telemetry for good.
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import type { OtlpLogEntry, OtlpLogsPayload, OtlpMetricsPayload, OtlpTracePayload } from "../../telemetry/otlp";
import { decodeLogRecords, decodeMetricPoints, decodeObservations, decodeTelemetryEvents } from "../../telemetry/otlp";
import { decodeLogsPayloadProto, decodeMetricsPayloadProto, decodeTracePayloadProto } from "../../telemetry/otlp-protobuf";
import { createCloudflareTelemetryStore } from "../../telemetry/store";
import type { LunoraActionContext, RouterEnv } from "./shared";
import { jsonError, otlpBearer, rejected, requireContext } from "./shared";

/**
 * Decompressed-size ceiling for an OTLP body. Bounds a `Content-Encoding: gzip`
 * "bomb" (a tiny body that inflates to GBs) — reading the stream in chunks and
 * aborting past this cap keeps a single request from OOMing the shared isolate.
 */
const MAX_OTLP_BODY_BYTES = 32 * 1024 * 1024;

/** Drain a byte stream to a single buffer, throwing once the running total exceeds {@link MAX_OTLP_BODY_BYTES}. */
const readAllCapped = async (stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> => {
    if (!stream) {
        return new Uint8Array();
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential stream drain
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            total += value.byteLength;

            if (total > MAX_OTLP_BODY_BYTES) {
                throw new Error("OTLP body exceeds the decompressed size limit");
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    if (chunks.length === 1) {
        return chunks[0];
    }

    const out = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return out;
};

/**
 * Read an OTLP body into the JSON payload shape the `decode*` functions consume.
 * Handles both transports — `application/json` (optionally `gzip`) and
 * `application/x-protobuf` (decoded by the Worker-safe `otlp-protobuf` module) —
 * so any OpenTelemetry SDK or Collector (which defaults to protobuf) can ship.
 * Every transport is drained through {@link readAllCapped}, so a decompression
 * bomb is bounded; an over-cap or malformed body throws → the handler returns 400.
 */
const readOtlpBody = async (request: Request, signal: "logs" | "metrics" | "traces"): Promise<unknown> => {
    const contentType = request.headers.get("content-type") ?? "";
    const gzipped = (request.headers.get("content-encoding") ?? "").includes("gzip");
    const stream = gzipped && request.body ? request.body.pipeThrough(new DecompressionStream("gzip")) : request.body;
    const bytes = await readAllCapped(stream);

    if (contentType.includes("protobuf")) {
        if (signal === "traces") {
            return decodeTracePayloadProto(bytes);
        }

        return signal === "logs" ? decodeLogsPayloadProto(bytes) : decodeMetricsPayloadProto(bytes);
    }

    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

/** The resolved OTLP caller — its bearer key and the org it's scoped to (looked up once). */
interface OtlpAuth {
    key: string;
    organizationId: string;
}

/**
 * Resolve the OTLP request's bearer to `{ key, organizationId }` (one org lookup,
 * reused by the handler), or a `Response` (401) to short-circuit. Capability-
 * agnostic here — an `ingest` or a legacy `deploy` key both authenticate; the
 * per-org scoping is enforced by the ingest mutation via `authorizeTelemetryKey`.
 */
const otlpAuthorize = async (request: Request, context: LunoraActionContext): Promise<OtlpAuth | Response> => {
    const key = otlpBearer(request);

    if (key === undefined) {
        return jsonError(401, "missing Authorization: Bearer <ingest key>");
    }

    const org = await context.runQuery<{ organizationId: string } | null>(internal.telemetry.orgForDeployKey, { deployKey: key });

    return org ? { key, organizationId: org.organizationId } : jsonError(401, "invalid or revoked ingest key");
};

/** Per-request caps; excess is dropped and reported via OTLP `partialSuccess`. */
const MAX_OTLP_OBSERVATIONS = 1000;
const MAX_OTLP_LOG_RECORDS = 500;
const MAX_OTLP_METRIC_POINTS = 500;

/**
 * OTLP success response. An empty body is full success; when the batch was capped
 * we return `partialSuccess` with the rejected count (per the OTLP spec), so an
 * exporter learns some points were dropped rather than seeing a silent success.
 */
const otlpAccepted = (rejectedCount: number, rejectedField: "rejectedDataPoints" | "rejectedLogRecords" | "rejectedSpans"): Response => {
    const body =
        rejectedCount > 0
            ? { partialSuccess: { errorMessage: `accepted with ${String(rejectedCount)} rejected (batch cap exceeded)`, [rejectedField]: rejectedCount } }
            : {};

    return Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });
};

/** Strip the routing-only `serviceName` off a decoded OTLP log entry, leaving the `logs.ingest` line shape. */
const toLogLine = ({ serviceName: _serviceName, ...line }: OtlpLogEntry): Omit<OtlpLogEntry, "serviceName"> => line;

/**
 * The shared preamble for every standard OTLP ingest endpoint: context check →
 * authorize (bearer → org, once) → read the body (JSON or protobuf, size-capped)
 * → run the signal's own ingest → respond with `partialSuccess` for the returned
 * rejected count. Each route below is then just its genuinely-unique body.
 */
const withOtlpIngest = async (
    request: Request,
    environment: RouterEnv,
    signal: "logs" | "metrics" | "traces",
    rejectedField: "rejectedDataPoints" | "rejectedLogRecords" | "rejectedSpans",
    ingest: (payload: unknown, auth: OtlpAuth, context: LunoraActionContext) => Promise<number>,
): Promise<Response> => {
    const context = requireContext(environment);

    const auth = await otlpAuthorize(request, context);

    if (auth instanceof Response) {
        return auth;
    }

    let payload: unknown;

    try {
        payload = await readOtlpBody(request, signal);
    } catch {
        return jsonError(400, "malformed or oversized OTLP body");
    }

    try {
        return otlpAccepted(await ingest(payload, auth, context), rejectedField);
    } catch (error) {
        // `rejected`, not a hardcoded 500. These are the STANDARD OTLP endpoints —
        // stock OpenTelemetry Collectors, which treat 5xx as non-retryable and drop
        // the batch. A throttled tenant hitting the 12k/min ingest bucket therefore
        // lost telemetry permanently instead of backing off on a 429 + Retry-After.
        // The Lunora-native `/v1/telemetry` route next door already does this, which
        // is why first-party testing never saw it.
        return rejected(error, "ingest failed");
    }
};

/**
 * `POST /v1/traces` — the **standard OTLP** trace ingest (mirrors Maple's /
 * Langfuse's OTLP endpoint), so any OpenTelemetry SDK or Collector can ship
 * traces — not only Lunora's own `otlpSink`. Every span is stored as an
 * observation (Traces) + tiered to the archive; error spans fold into Issues.
 */
export const handleOtlpTracesRoute = (request: Request, environment: RouterEnv): Promise<Response> =>
    withOtlpIngest(request, environment, "traces", "rejectedSpans", async (payload, auth, context) => {
        const body = payload as OtlpTracePayload;
        const decoded = decodeObservations(body);
        const observations = decoded.slice(0, MAX_OTLP_OBSERVATIONS);

        await context.runMutation(api.telemetry.ingest, {
            deployKey: auth.key,
            events: decodeTelemetryEvents(body),
            observations,
            organizationId: auth.organizationId,
        });

        // Tier the spans to the columnar archive (fire-and-forget; scales past D1).
        await createCloudflareTelemetryStore(environment)
            .archiveSpans(observations, auth.organizationId)
            .catch(() => undefined);

        return decoded.length - observations.length;
    });

/**
 * `POST /v1/logs` — the **standard OTLP** logs ingest. Records decode to tenant
 * log lines, grouped by `service.name` (→ script), stored via `logs.ingest`.
 */
export const handleOtlpLogsRoute = (request: Request, environment: RouterEnv): Promise<Response> =>
    withOtlpIngest(request, environment, "logs", "rejectedLogRecords", async (payload, auth, context) => {
        const decoded = decodeLogRecords(payload as OtlpLogsPayload);
        const kept = decoded.slice(0, MAX_OTLP_LOG_RECORDS);

        // OTLP logs carry `service.name` per resource; the store keys lines by
        // script, so group the batch by service and ingest one call per script.
        const byScript = new Map<string, OtlpLogEntry[]>();

        for (const entry of kept) {
            const script = entry.serviceName ?? "unknown";
            const group = byScript.get(script);

            if (group) {
                group.push(entry);
            } else {
                byScript.set(script, [entry]);
            }
        }

        for (const [scriptName, entries] of byScript) {
            // eslint-disable-next-line no-await-in-loop -- one call per script; a batch spans few
            await context.runMutation(api.logs.ingest, {
                deployKey: auth.key,
                lines: entries.map((entry) => toLogLine(entry)),
                organizationId: auth.organizationId,
                scriptName,
            });
        }

        return decoded.length - kept.length;
    });

/**
 * `POST /v1/metrics` — the **standard OTLP** metrics ingest. Each data point is
 * flattened, stored as an exact D1 `metricPoints` row (the precise tier behind
 * `metrics.series`) AND mirrored to the Analytics Engine dataset (the sampled
 * >retention archive, `metrics.list`).
 */
export const handleOtlpMetricsRoute = (request: Request, environment: RouterEnv): Promise<Response> =>
    withOtlpIngest(request, environment, "metrics", "rejectedDataPoints", async (payload, auth, context) => {
        const decoded = decodeMetricPoints(payload as OtlpMetricsPayload);
        const kept = decoded.slice(0, MAX_OTLP_METRIC_POINTS);

        // Exact tier: persist each point in D1 (deploy-key authorized inside the mutation).
        await context.runMutation(api.metrics.ingest, {
            deployKey: auth.key,
            organizationId: auth.organizationId,
            points: kept.map((point) => {
                return {
                    at: point.at,
                    ...(point.functionPath === undefined ? {} : { functionPath: point.functionPath }),
                    kind: point.kind,
                    name: point.name,
                    ...(point.serviceName === undefined ? {} : { serviceName: point.serviceName }),
                    value: point.value,
                };
            }),
        });

        // Sampled mirror — AE writes are fire-and-forget; a missing/throwing binding no-ops.
        try {
            createCloudflareTelemetryStore(environment).recordMetrics(kept, auth.organizationId);
        } catch {
            // A throwing/absent dataset binding must not fail the ingest.
        }

        return decoded.length - kept.length;
    });
