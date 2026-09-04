import { summarizeUptime } from "../src/uptime/probe";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * Synthetic uptime (§ Observability). The control plane's every-minute sweep
 * (`src/uptime/sweep.ts`) probes each live deployment's URL from the outside and
 * writes a `uptimeChecks` row + advances `uptimeState`. These read-only functions
 * back the dashboard's Uptime page: {@link summary} (current status + rolling
 * uptime per deployment) and {@link recent} (a deployment's probe timeline). The
 * writes happen at the edge, not here — a mutation can't `fetch` an external URL.
 */

/** Checks folded into a deployment's rolling uptime figure — one hour at minute resolution. */
const SUMMARY_WINDOW = 60;

/** Probe rows a timeline read returns at most. */
const RECENT_LIMIT = 120;

/** Keep two weeks of probe history; older rows are pruned. */
const CHECK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Oldest rows scanned per prune run. `uptimeChecks` is the fastest-growing table
 * here (deployments × probes/day), so — with no range-`where` in the D1 ctx-db —
 * the prune reads a bounded oldest-first page instead of the whole table, keeping
 * a run's memory bounded; successive 6-hourly runs chip through any backlog.
 */
const PRUNE_SCAN_LIMIT = 2000;

interface UptimeCheckRow {
    _id: Id<"uptimeChecks">;
    createdAt: number;
    error?: string;
    latencyMs?: number;
    ok: boolean;
    statusCode?: number;
}

/** One deployment's current uptime status + rolling figure, for the dashboard grid. */
interface UptimeSummaryRow {
    avgLatencyMs?: number;
    consecutiveFailures: number;
    deploymentId: Id<"deployments">;
    lastCheckedAt: number;
    ok: boolean;
    sampleCount: number;
    upFraction: number;
}

/** Current status + rolling uptime for every probed deployment in the org (any member). */
export const summary = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<UptimeSummaryRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.uptimeState.findMany({ where: { organizationId } });
        const states = page;

        const rows = await Promise.all(
            states.map(async (state): Promise<UptimeSummaryRow> => {
                const { page: checkPage } = await context.db.uptimeChecks.findMany({
                    limit: SUMMARY_WINDOW,
                    orderBy: [{ createdAt: "desc" }],
                    where: { deploymentId: state.deploymentId, organizationId },
                });
                const summarized = summarizeUptime(checkPage);

                return {
                    ...(summarized.avgLatencyMs === undefined ? {} : { avgLatencyMs: summarized.avgLatencyMs }),
                    consecutiveFailures: state.consecutiveFailures,
                    deploymentId: state.deploymentId,
                    lastCheckedAt: state.lastCheckedAt,
                    // Live status comes from the state row (the newest tick), not the windowed
                    // summary, so a just-recovered deployment reads up immediately.
                    ok: state.lastOk,
                    sampleCount: summarized.sampleCount,
                    upFraction: summarized.upFraction,
                };
            }),
        );

        return rows.toSorted((a, b) => Number(a.ok) - Number(b.ok) || b.lastCheckedAt - a.lastCheckedAt);
    });

/** A single deployment's recent probe timeline, newest first (any member). */
export const recent = query
    .input({ deploymentId: v.id("deployments"), limit: v.optional(v.number()), organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args }): Promise<UptimeCheckRow[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? RECENT_LIMIT), 1), RECENT_LIMIT);
        const { page } = await context.db.uptimeChecks.findMany({
            limit,
            orderBy: [{ createdAt: "desc" }],
            where: { deploymentId: args.deploymentId, organizationId: args.organizationId },
        });

        return page;
    });

/** Prune probe rows past the retention window so the time series stays bounded. */
export const prune = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const cutoff = context.now - CHECK_RETENTION_MS;
    // Oldest-first and bounded, with the cutoff as a `where` predicate so the page
    // holds only rows to delete rather than whatever sorts first.
    const { page } = await context.db.uptimeChecks.findMany({
        limit: PRUNE_SCAN_LIMIT,
        orderBy: [{ createdAt: "asc" }],
        where: { createdAt: { lt: cutoff } },
    });
    const stale = page;

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.delete(row._id);
    }

    return { pruned: stale.length };
});
