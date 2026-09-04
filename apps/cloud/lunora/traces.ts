import type { SpanObservation } from "../src/telemetry/otlp";
import type { TelemetryStoreEnv } from "../src/telemetry/store";
import { createCloudflareTelemetryStore } from "../src/telemetry/store";
import { filterTraces } from "../src/telemetry/trace-query";
import type { ObservationSpan } from "../src/telemetry/trace-tree";
import { foldObservationTraces } from "../src/telemetry/trace-tree";
import type { Id } from "./_generated/dataModel.js";
import { action, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Traces over stored **observations** (spans) — the real-duration Traces model
 * (GAPS.md B2, the Langfuse-teardown follow-on). `list` rolls recent spans up
 * into one row per trace (real latency, span/error counts, root op); `get`
 * returns a trace's spans (D1 hot window) for the nested waterfall;
 * `getArchived` reads a trace's spans back from the columnar archive (R2 SQL
 * over Iceberg) for traces that have aged out of D1. All members-only. The
 * per-trace folding + tree layout live in the pure `src/telemetry/trace-tree`.
 */

/** Default number of traces {@link list} returns. */
const DEFAULT_TRACE_LIMIT = 50;

/** Hard cap on {@link list} output. */
const MAX_TRACE_LIMIT = 200;

/** Recent spans scanned before folding into traces (bounds the read). */
const SCAN_LIMIT = 2000;

/** One stored observation row, as the queries read it. */
interface ObservationRow extends ObservationSpan {
    _id: Id<"observations">;
    deploymentId?: Id<"deployments">;
    organizationId: Id<"organizations">;
}

/** One folded trace as the dashboard consumes it — mirrors `TraceRollup` locally so codegen inlines it. */
interface TraceRollupView {
    durationMs: number;
    endedAt: number;
    errorCount: number;
    rootFunctionPath?: string;
    rootName: string;
    spanCount: number;
    startedAt: number;
    traceId: string;
}

/** One span in a trace — mirrors `ObservationSpan` locally so codegen inlines it. */
interface SpanView {
    attributes?: Record<string, string>;
    completionTokens?: number;
    durationMs: number;
    endedAt: number;
    evaluations?: { label?: string; name: string; score: number }[];
    functionPath?: string;
    input?: string;
    kind?: "container" | "generation" | "worker";
    level: "error" | "info";
    model?: string;
    name: string;
    output?: string;
    parentSpanId?: string;
    promptTokens?: number;
    sessionId?: string;
    spanId: string;
    startedAt: number;
    statusMessage?: string;
    traceId: string;
}

/**
 * Recent dispatch traces, newest-active first, folded from the span store: one
 * row per `traceId` with the real trace latency, span/error counts, and root
 * operation. Server-side filters: `deploymentId` (scans that deployment's own
 * spans via `by_org_deployment_started`, so a quiet deployment's older traces
 * don't fall off the global recent window), `errorOnly`, `minDurationMs`,
 * `functionPath` (substring over the root op), and a `from`/`to` time window
 * (`to` doubles as the "load older" cursor). Bounded by `limit`
 * (default {@link DEFAULT_TRACE_LIMIT}), folded over the most recent
 * {@link SCAN_LIMIT} spans. Members only.
 */
export const list = query
    .input({
        deploymentId: v.optional(v.id("deployments")),
        errorOnly: v.optional(v.boolean()),
        from: v.optional(v.number()),
        functionPath: v.optional(boundedString(LIMITS.token)),
        limit: v.optional(v.number()),
        minDurationMs: v.optional(v.number()),
        organizationId: v.id("organizations"),
        to: v.optional(v.number()),
    })
    .query(async ({ ctx: context, args }): Promise<TraceRollupView[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_TRACE_LIMIT), 1), MAX_TRACE_LIMIT);

        // Push `deploymentId` into the query (its own index) so the scanned window
        // is that deployment's spans, not the global recent window.
        const { page } = await context.db.observations.findMany({
            limit: SCAN_LIMIT,
            orderBy: [{ startedAt: "desc" }],
            where:
                args.deploymentId === undefined
                    ? { organizationId: args.organizationId }
                    : { deploymentId: args.deploymentId, organizationId: args.organizationId },
        });

        const spans = page;

        // Fold every scanned span, then apply the trace-level filters, then cap —
        // filtering after the cap would return fewer than `limit` matching traces.
        const folded = foldObservationTraces(spans, SCAN_LIMIT);
        const filtered = filterTraces(folded, {
            errorOnly: args.errorOnly,
            from: args.from,
            functionPath: args.functionPath,
            minDurationMs: args.minDurationMs,
            to: args.to,
        });

        return filtered.slice(0, limit);
    });

/**
 * Older traces folded straight out of the columnar archive (R2 SQL over Iceberg),
 * for the `[from, to]` window that reaches past D1's hot retention. An **action**
 * (the read is a `fetch` over R2 SQL; only actions carry `ctx.env`). Same
 * fail-open contract as {@link getArchived}: an unconfigured cell yields `[]`, so
 * the Traces list seamlessly shows "load older" results where the archive exists
 * and simply stops at the hot window where it doesn't. The client merges these
 * with the hot {@link list} rollups (deduping by `traceId`, hot wins). Members only.
 */
export const listArchived = action
    .use(rateLimit("archive"))
    .input({
        from: v.number(),
        limit: v.optional(v.number()),
        organizationId: v.id("organizations"),
        to: v.number(),
    })
    .action(async ({ ctx: context, args }): Promise<TraceRollupView[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_TRACE_LIMIT), 1), MAX_TRACE_LIMIT);
        const environment = (context.env ?? {}) as Partial<TelemetryStoreEnv>;
        const store = createCloudflareTelemetryStore({
            CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
            R2_SQL_TOKEN: environment.R2_SQL_TOKEN,
            TELEMETRY_BUCKET_NAME: environment.TELEMETRY_BUCKET_NAME,
            TELEMETRY_SPAN_TABLE: environment.TELEMETRY_SPAN_TABLE,
            fetch: context.fetch,
        });

        const spans = await store.readArchivedSpansInWindow({ from: args.from, limit: SCAN_LIMIT, organizationId: args.organizationId, to: args.to });

        // Reuse the same fold as the hot `list`, then cap.
        return foldObservationTraces(spans, SCAN_LIMIT).slice(0, limit);
    });

/** Project a stored/archived span onto the wire {@link SpanView} (drops `_id` / `organizationId` / `serviceName`). */
const toSpanView = (span: ObservationRow | SpanObservation): SpanView => {
    return {
        attributes: span.attributes,
        completionTokens: span.completionTokens,
        durationMs: span.durationMs,
        endedAt: span.endedAt,
        evaluations: span.evaluations,
        functionPath: span.functionPath,
        input: span.input,
        kind: span.kind,
        level: span.level,
        model: span.model,
        name: span.name,
        output: span.output,
        parentSpanId: span.parentSpanId,
        promptTokens: span.promptTokens,
        sessionId: span.sessionId,
        spanId: span.spanId,
        startedAt: span.startedAt,
        statusMessage: span.statusMessage,
        traceId: span.traceId,
    };
};

/**
 * Every span in one trace (`by_trace` index), for the drill-in waterfall. The
 * client lays them out with `buildTraceTree` (real durations + `parentSpanId`
 * nesting). Members only. Serves D1's hot window only — a trace older than the
 * retention window comes back empty here; the client then falls back to
 * {@link getArchived}.
 */
export const get = query
    .input({
        organizationId: v.id("organizations"),
        traceId: boundedString(LIMITS.id),
    })
    .query(async ({ ctx: context, args }): Promise<SpanView[]> => {
        await assertMember(context, args.organizationId);

        const { page } = await context.db.observations.findMany({
            where: { organizationId: args.organizationId, traceId: args.traceId },
        });

        return page.map((row) => toSpanView(row));
    });

/**
 * The archive fallback for {@link get}: read one trace's spans back from the
 * columnar archive (R2 SQL over the Iceberg table `archiveSpans` tiers spans to)
 * for a trace that has aged past D1's hot window. An **action** — the read is a
 * `fetch` over the R2-SQL HTTP endpoint, which only actions can make (and only
 * they carry `ctx.env`, the R2-SQL token/account). Members only.
 *
 * Fails **open**: `readArchivedTrace` returns `[]` when R2 SQL isn't configured
 * (no `R2_SQL_TOKEN` / account id / bucket in `ctx.env` — the common case until
 * a cell provisions the archive) or on any query failure, so this never errors
 * on the client's fallback path — it just yields no spans, and the Traces tab
 * shows the D1-empty state. The client shows a "from archive" badge when this
 * returns spans.
 */
export const getArchived = action
    .use(rateLimit("archive"))
    .input({
        organizationId: v.id("organizations"),
        traceId: boundedString(LIMITS.id),
    })
    .action(async ({ ctx: context, args }): Promise<SpanView[]> => {
        await assertMember(context, args.organizationId);

        // `ctx.env` is the validated env contract (`lunora/env.ts`); undefined when
        // unset. All keys are optional, so an unconfigured cell yields an all-empty
        // store env → `readArchivedTrace` short-circuits to `[]` (fail-open).
        const environment = (context.env ?? {}) as Partial<TelemetryStoreEnv>;
        const store = createCloudflareTelemetryStore({
            CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
            R2_SQL_TOKEN: environment.R2_SQL_TOKEN,
            TELEMETRY_BUCKET_NAME: environment.TELEMETRY_BUCKET_NAME,
            TELEMETRY_SPAN_TABLE: environment.TELEMETRY_SPAN_TABLE,
            fetch: context.fetch,
        });

        const spans = await store.readArchivedTrace({ organizationId: args.organizationId, traceId: args.traceId });

        return spans.map((row) => toSpanView(row));
    });
