import { filterTraces } from "../src/telemetry/trace-query";
import type { ObservationSpan } from "../src/telemetry/trace-tree";
import { foldObservationTraces } from "../src/telemetry/trace-tree";
import type { Id } from "./_generated/dataModel.js";
import { query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * Traces over stored **observations** (spans) — the real-duration Traces model
 * (GAPS.md B2, the Langfuse-teardown follow-on). `list` rolls recent spans up
 * into one row per trace (real latency, span/error counts, root op); `get`
 * returns a trace's spans for the nested waterfall. Both members-only. The
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
    completionTokens?: number;
    durationMs: number;
    endedAt: number;
    functionPath?: string;
    input?: string;
    kind?: "container" | "generation" | "worker";
    level: "error" | "info";
    model?: string;
    name: string;
    output?: string;
    parentSpanId?: string;
    promptTokens?: number;
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
        functionPath: v.optional(v.string()),
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

        const spans = page as unknown as ObservationRow[];

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
 * Every span in one trace (`by_trace` index), for the drill-in waterfall. The
 * client lays them out with `buildTraceTree` (real durations + `parentSpanId`
 * nesting). Members only.
 */
export const get = query
    .input({
        organizationId: v.id("organizations"),
        traceId: v.string(),
    })
    .query(async ({ ctx: context, args }): Promise<SpanView[]> => {
        await assertMember(context, args.organizationId);

        const { page } = await context.db.observations.findMany({
            where: { organizationId: args.organizationId, traceId: args.traceId },
        });

        return (page as unknown as ObservationRow[]).map((span) => ({
            completionTokens: span.completionTokens,
            durationMs: span.durationMs,
            endedAt: span.endedAt,
            functionPath: span.functionPath,
            input: span.input,
            kind: span.kind,
            level: span.level,
            model: span.model,
            name: span.name,
            output: span.output,
            parentSpanId: span.parentSpanId,
            promptTokens: span.promptTokens,
            spanId: span.spanId,
            startedAt: span.startedAt,
            statusMessage: span.statusMessage,
            traceId: span.traceId,
        }));
    });
