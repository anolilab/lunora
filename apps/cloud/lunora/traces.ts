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
 * operation. Optionally scoped to one deployment (filtered over the scanned
 * window). Bounded by `limit` (default {@link DEFAULT_TRACE_LIMIT}), folded over
 * the most recent {@link SCAN_LIMIT} spans. Members only.
 */
export const list = query
    .input({
        deploymentId: v.optional(v.id("deployments")),
        limit: v.optional(v.number()),
        organizationId: v.id("organizations"),
    })
    .query(async ({ ctx: context, args }): Promise<TraceRollupView[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_TRACE_LIMIT), 1), MAX_TRACE_LIMIT);

        const { page } = await context.db.observations.findMany({
            limit: SCAN_LIMIT,
            orderBy: [{ startedAt: "desc" }],
            where: { organizationId: args.organizationId },
        });

        const spans = page as unknown as ObservationRow[];
        const scoped = args.deploymentId === undefined ? spans : spans.filter((span) => span.deploymentId === args.deploymentId);

        return foldObservationTraces(scoped, limit);
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
