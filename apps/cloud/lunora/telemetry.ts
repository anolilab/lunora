import { fingerprintError } from "@lunora/fingerprint";
import { LunoraError } from "@lunora/server";

import type { AlertDelivery as AlertDeliveryBase, FiringRule, MetricRule, MetricTarget } from "../src/telemetry/alerts";
import { fireCrossedRules, fireMetricRules } from "../src/telemetry/alerts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, v } from "./_generated/server.js";
import { assertRowInOrg, authorizeTelemetryKey, resolveDeployKeyOrg } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Telemetry ingest for the Cloud Observability pipeline (superlog model). The
 * tenant Worker's `otlpSink` and the container OTLP exporter POST OTLP to
 * `POST /v1/telemetry`; the router decodes it to normalized error events and
 * calls this deploy-key-authorized mutation, which fingerprints each event (via
 * `@lunora/fingerprint`) and folds it onto one `issues` row per (org, hash).
 * Container events additionally open/update an `incidents` row.
 *
 * Synchronous, no queue: fingerprinting is pure and the writes are a bounded set
 * of indexed D1 upserts, and the control-plane mutation is serialized — so the
 * cheap path is a direct insert/patch (mirrors `usage.ingest` / `logs.ingest`),
 * not a fan-out job. Raw span/log archival + metrics ride a fire-and-forget
 * side-channel in the router handler, never blocking or failing ingest.
 */

/** Batch cap per ingest call — the tenant sink flushes well below this. */
const MAX_EVENTS = 500;

/** Batch cap on the span observations one ingest call may carry. */
const MAX_OBSERVATIONS = 1000;

/** One decoded span (all spans, not just errors), stored as an observation for Traces — the router's `SpanObservation`. */
const observationInput = v.object({
    attributes: v.optional(v.record(v.string(), v.string())),
    completionTokens: v.optional(v.number()),
    durationMs: v.number(),
    endedAt: v.number(),
    // Generation spans: eval scores from `gen_ai.evaluation.*` (defensive — absent today).
    evaluations: v.optional(v.array(v.object({ label: v.optional(v.string()), name: v.string(), score: v.number() }))),
    functionPath: v.optional(v.string()),
    input: v.optional(v.string()),
    kind: v.union(v.literal("container"), v.literal("generation"), v.literal("worker")),
    level: v.union(v.literal("error"), v.literal("info")),
    model: v.optional(v.string()),
    name: v.string(),
    output: v.optional(v.string()),
    parentSpanId: v.optional(v.string()),
    promptTokens: v.optional(v.number()),
    serviceName: v.optional(v.string()),
    // Generation spans: conversation/thread id (`gen_ai.conversation.id`) grouping turns into a session.
    sessionId: v.optional(v.string()),
    spanId: v.string(),
    startedAt: v.number(),
    statusMessage: v.optional(v.string()),
    traceId: v.string(),
});

/** A normalized error event, decoded from an OTLP error span by the router. */
const telemetryEvent = v.object({
    // The Lunora error code, when the span carried `error.type` (metadata only).
    code: v.optional(v.string()),
    // Container name, for `kind: "container"` events.
    container: v.optional(v.string()),
    // Function path (`messages:list`) or `container:<name>` — the fingerprint culprit.
    functionPath: v.string(),
    // Container DO instance id, when known.
    instance: v.optional(v.string()),
    kind: v.union(v.literal("error"), v.literal("container")),
    message: v.string(),
    // The error span's trace id — carried onto the Issue as a sample link.
    traceId: v.optional(v.string()),
    // Event time in epoch ms (decoded from the span's end time).
    ts: v.number(),
});

/** Count-crossing rule targets the ingest evaluates via `fireCrossedRules`. */
const COUNT_TARGETS = new Set(["incident", "issue"]);

/** Metric-window rule targets the ingest evaluates via `fireMetricRules`. */
const METRIC_TARGETS = new Set<MetricTarget>(["error_rate", "latency_p95", "llm_cost"]);

/** Recent spans scanned when a metric rule needs its window (bounds the read). */
const METRIC_SCAN_LIMIT = 2000;

/** A fired alert the router should deliver (email/webhook) then mark delivered — the shared shape at this store's branded id. */
export type AlertDelivery = AlertDeliveryBase<Id<"alerts">>;

/** A batch group: all events sharing one fingerprint hash, pre-aggregated. */
interface EventGroup {
    container?: string;
    count: number;
    culprit: string;
    hash: string;
    instance?: string;
    kind: "container" | "error";
    lastTs: number;
    sampleMessage: string;
    /** A sample trace id (the latest event's), so the Issue links to a trace. */
    sampleTraceId?: string;
    title: string;
}

/** Classify a container failure from its message (crash-loop is the default). */
const detectIncidentKind = (message: string): "crash_loop" | "error_spike" | "oom" => {
    const lowered = message.toLowerCase();

    return lowered.includes("oom") || lowered.includes("out of memory") || lowered.includes("exit 137") ? "oom" : "crash_loop";
};

/** Fold a batch of events into one pre-aggregated group per fingerprint hash. */
const groupEvents = (
    events: {
        code?: string;
        container?: string;
        functionPath: string;
        instance?: string;
        kind: "container" | "error";
        message: string;
        traceId?: string;
        ts: number;
    }[],
): Map<string, EventGroup> => {
    const groups = new Map<string, EventGroup>();

    for (const event of events) {
        const fingerprint = fingerprintError({ code: event.code, functionPath: event.functionPath, message: event.message });
        const group = groups.get(fingerprint.hash);

        if (group) {
            group.count += 1;
            group.lastTs = Math.max(group.lastTs, event.ts);
            group.sampleMessage = event.message;
            group.sampleTraceId = event.traceId ?? group.sampleTraceId;
        } else {
            groups.set(fingerprint.hash, {
                container: event.container,
                count: 1,
                culprit: fingerprint.culprit,
                hash: fingerprint.hash,
                instance: event.instance,
                kind: event.kind,
                lastTs: event.ts,
                sampleMessage: event.message,
                sampleTraceId: event.traceId,
                title: fingerprint.title,
            });
        }
    }

    return groups;
};

/**
 * Upsert one issue group; returns its count before/after so rules can evaluate.
 *
 * Exported so codegen's write-side discovery can attribute its
 * `ctx.db.insert("issues", …)` to a real function — the feeder only walks
 * exported declarations, so as a file-local helper this insert was invisible and
 * `issues` looked like a table nothing ever wrote to.
 */
export const upsertIssue = async (
    context: MutationContext,
    group: EventGroup,
    organizationId: Id<"organizations">,
    deploymentId: Id<"deployments"> | undefined,
    now: number,
): Promise<{ after: number; before: number }> => {
    const { page } = await context.db.issues.findMany({ where: { hash: group.hash, organizationId } });
    const existing = page[0];
    const before = existing ? existing.count : 0;

    if (existing) {
        await context.db.patch(existing._id, {
            count: before + group.count,
            lastSeen: Math.max(existing.lastSeen, group.lastTs),
            sampleMessage: group.sampleMessage,
            // Only refresh the sample trace when this batch carried one.
            ...(group.sampleTraceId ? { sampleTraceId: group.sampleTraceId } : {}),
            updatedAt: now,
        });
    } else {
        await context.db.insert("issues", {
            count: group.count,
            createdAt: now,
            culprit: group.culprit,
            deploymentId,
            firstSeen: group.lastTs,
            hash: group.hash,
            lastSeen: group.lastTs,
            organizationId,
            sampleMessage: group.sampleMessage,
            sampleTraceId: group.sampleTraceId,
            status: "open",
            title: group.title,
            updatedAt: now,
        });
    }

    return { after: before + group.count, before };
};

/** Upsert one container group's incident; returns its count before/after. Exported for the same reason as {@link upsertIssue}. */
export const upsertIncident = async (
    context: MutationContext,
    group: EventGroup,
    organizationId: Id<"organizations">,
    deploymentId: Id<"deployments"> | undefined,
    now: number,
): Promise<{ after: number; before: number }> => {
    const { page } = await context.db.incidents.findMany({ where: { hash: group.hash, organizationId } });
    const existing = page[0];
    const before = existing ? existing.count : 0;

    if (existing) {
        await context.db.patch(existing._id, { count: before + group.count, lastSeen: Math.max(existing.lastSeen, group.lastTs), updatedAt: now });
    } else {
        await context.db.insert("incidents", {
            container: group.container,
            count: group.count,
            createdAt: now,
            deploymentId,
            hash: group.hash,
            instance: group.instance,
            kind: detectIncidentKind(group.sampleMessage),
            lastSeen: group.lastTs,
            openedAt: now,
            organizationId,
            status: "open",
            title: group.title,
            updatedAt: now,
        });
    }

    return { after: before + group.count, before };
};

/**
 * Ingest a batch of normalized error events (deploy-key authorized — the tenant
 * sink holds an org deploy key). Events are folded into per-hash groups first so
 * a repeated error in one batch is a single upsert (and never a duplicate insert
 * under the unique `(org, hash)` index).
 */
export const ingest = mutation
    .use(rateLimit("ingest"))
    .input({
        deployKey: boundedString(LIMITS.token),
        deploymentId: v.optional(v.id("deployments")),
        events: v.array(telemetryEvent),
        observations: v.optional(v.array(observationInput)),
        organizationId: v.id("organizations"),
    })
    .mutation(
        async ({
            ctx: context,
            args,
        }): Promise<{
            // Inlined (not `AlertDelivery[]`, and the channel union spelled out not
            // via the `AlertChannel` alias) so codegen serializes the return type
            // without an unresolved type reference — see `members.ts`.
            alerts: { body: string; channel: "email" | "pagerduty" | "slack" | "webhook"; destination: string; id: Id<"alerts">; subject: string }[];
            incidents: number;
            issues: number;
        }> => {
            await authorizeTelemetryKey(context, args.organizationId, args.deployKey);

            if (args.events.length > MAX_EVENTS) {
                throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_EVENTS)} events)`);
            }

            if ((args.observations?.length ?? 0) > MAX_OBSERVATIONS) {
                throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_OBSERVATIONS)} observations)`);
            }

            const { now } = context;

            // Caller-supplied, and only its ORG is authorized above — without this a
            // tenant can attribute its spans to another org's deployment. Reads stay
            // org-scoped either way; what breaks is per-deployment attribution.
            if (args.deploymentId !== undefined) {
                await assertRowInOrg(context, args.deploymentId, args.organizationId, "deployment");
            }

            // Persist every span as an observation (Traces). Additive to the error
            // fold below — the same OTLP payload feeds both. Best-effort per row so
            // one bad span never fails the batch or the Issue path.
            for (const observation of args.observations ?? []) {
                // eslint-disable-next-line no-await-in-loop -- bounded batch; sequential keeps the writer simple
                await context.db.insert("observations", {
                    ...observation,
                    createdAt: now,
                    deploymentId: args.deploymentId,
                    organizationId: args.organizationId,
                });
            }
            const { page: rulePage } = await context.db.alertRules.findMany({ where: { organizationId: args.organizationId } });
            const enabledRules = rulePage.filter((rule) => rule.enabled);
            // Count-crossing rules (issue/incident) evaluated per upserted group below.
            const rules: FiringRule[] = enabledRules
                .filter((rule) => COUNT_TARGETS.has(rule.target))
                .map((rule) => {
                    return {
                        channel: rule.channel,
                        destination: rule.destination,
                        name: rule.name,
                        ruleId: rule._id,
                        target: rule.target as "incident" | "issue",
                        threshold: rule.threshold,
                    };
                });
            // Metric-window rules (error_rate/latency_p95/llm_cost) evaluated once
            // over the freshly-ingested observation window, after the loop.
            const metricRules: MetricRule[] = enabledRules
                .filter((rule): rule is (typeof enabledRules)[number] & { target: MetricTarget } => METRIC_TARGETS.has(rule.target as MetricTarget))
                .map((rule) => {
                    return {
                        baselineWindows: rule.baselineWindows,
                        channel: rule.channel,
                        comparator: rule.comparator ?? "gt",
                        destination: rule.destination,
                        functionPath: rule.functionPath,
                        mode: rule.mode,
                        name: rule.name,
                        ruleId: rule._id,
                        target: rule.target,
                        threshold: rule.threshold,
                        windowMinutes: rule.windowMinutes ?? 60,
                    };
                });
            const firedAlerts: AlertDelivery[] = [];

            // The typed ctx.db insert, adapted to the shared firing loop's structural
            // row (cast is the same idiom the rulePage read above uses).
            const insertAlert = (row: Record<string, unknown>): Promise<Id<"alerts">> => context.db.insert("alerts", row);

            // Fire every enabled rule this source's count just crossed, via the shared
            // `fireCrossedRules` — the same firing loop + `alerts` row shape the uptime
            // sweep uses, so the two paths can't drift.
            const evaluateRules = async (
                target: "incident" | "issue",
                source: { after: number; before: number; culprit: string; hash: string; sampleMessage: string; title: string },
            ): Promise<void> => {
                const fired = await fireCrossedRules(rules, { ...source, organizationId: args.organizationId, target }, insertAlert, now);

                firedAlerts.push(...fired);
            };

            const groups = groupEvents(args.events);
            let issues = 0;
            let incidents = 0;

            for (const group of groups.values()) {
                // eslint-disable-next-line no-await-in-loop -- bounded, pre-grouped batch; the global mutation is serialized
                const issueCounts = await upsertIssue(context, group, args.organizationId, args.deploymentId, now);

                issues += 1;
                // eslint-disable-next-line no-await-in-loop -- see above
                await evaluateRules("issue", {
                    after: issueCounts.after,
                    before: issueCounts.before,
                    culprit: group.culprit,
                    hash: group.hash,
                    sampleMessage: group.sampleMessage,
                    title: group.title,
                });

                if (group.kind !== "container") {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- see above
                const incidentCounts = await upsertIncident(context, group, args.organizationId, args.deploymentId, now);

                incidents += 1;
                // eslint-disable-next-line no-await-in-loop -- see above
                await evaluateRules("incident", {
                    after: incidentCounts.after,
                    before: incidentCounts.before,
                    culprit: group.culprit,
                    hash: group.hash,
                    sampleMessage: group.sampleMessage,
                    title: group.title,
                });
            }

            // Metric-window rules — evaluated over the org's recent observations
            // (this batch's spans are already persisted above), only when such a
            // rule exists so the common no-metric-rules path pays nothing. This is
            // the fast-feedback path; the level-triggered latch in `alertRuleState`
            // (shared with the periodic sweep in `src/telemetry/sweep.ts`) makes a
            // sustained breach alert once and lets a quiet window still clear + re-arm.
            if (metricRules.length > 0) {
                const { page: windowObservations } = await context.db.observations.findMany({
                    limit: METRIC_SCAN_LIMIT,
                    orderBy: [{ startedAt: "desc" }],
                    where: { organizationId: args.organizationId },
                });
                const { page: statePage } = await context.db.alertRuleState.findMany({ where: { organizationId: args.organizationId } });
                const stateByRule = new Map(statePage.map((row) => [row.ruleId as string, row]));

                const outcome = await fireMetricRules(
                    metricRules,
                    windowObservations,
                    args.organizationId,
                    {
                        insertAlert,
                        wasFiring: (ruleId) => stateByRule.get(ruleId)?.firing ?? false,
                        writeState: async (ruleId, firing, value) => {
                            const existing = stateByRule.get(ruleId);

                            await (existing
                                ? context.db.patch(existing._id, { firing, lastEvaluatedAt: now, lastValue: value, updatedAt: now })
                                : context.db.insert("alertRuleState", {
                                      createdAt: now,
                                      firing,
                                      lastEvaluatedAt: now,
                                      lastValue: value,
                                      organizationId: args.organizationId,
                                      ruleId,
                                      updatedAt: now,
                                  }));
                        },
                    },
                    now,
                );

                firedAlerts.push(...outcome.deliveries);
            }

            return { alerts: firedAlerts, incidents, issues };
        },
    );

/**
 * Span observations older than this are pruned from D1's hot window. Set to 7
 * days (up from the original 48 h) so recent Traces browse further back without
 * a round-trip to the columnar archive. Traces older than this are served from
 * the R2/Iceberg archive via {@link traces.listArchived} / {@link traces.getArchived},
 * so history is effectively unbounded where a cell has provisioned the archive —
 * the hot window is a latency/cost tier, not the retention limit.
 */
export const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows one prune tick deletes. Bounds a single mutation; a backlog drains over ticks. */
const PRUNE_BATCH = 1000;

/** Delete span observations past retention (Traces). SYSTEM only (cron dispatch). */
export const pruneObservations = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const cutoff = context.now - OBSERVATION_RETENTION_MS;
    // Filter in the QUERY, not after it: the cutoff is a `where` predicate, so every
    // row on the page is a row to delete and the sweep can never fill its page with
    // rows it does not want. Oldest-first keeps a backlog draining in cutoff order,
    // and PRUNE_BATCH bounds the work one cron tick does — a table far past retention
    // converges over several ticks instead of timing out on one.
    const { page: stale } = await context.db.observations.findMany({
        limit: PRUNE_BATCH,
        orderBy: [{ startedAt: "asc" }],
        where: { startedAt: { lt: cutoff } },
    });

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.delete(row._id);
    }

    return { pruned: stale.length };
});

/**
 * Resolve the org that owns a deploy key, for the standard OTLP ingest endpoints
 * (`/v1/traces`, `/v1/logs`) — a stock OpenTelemetry exporter sends only an
 * `Authorization: Bearer &lt;key>` header, so the route resolves the org from the
 * key before delegating to the deploy-key-authorized ingest. SYSTEM only.
 */
export const orgForDeployKey = internalQuery
    .input({ deployKey: boundedString(LIMITS.token) })
    .query(async ({ ctx: context, args }): Promise<{ organizationId: Id<"organizations"> } | null> => {
        const organizationId = await resolveDeployKeyOrg(context, args.deployKey);

        return organizationId ? { organizationId } : null;
    });
