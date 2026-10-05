/**
 * Observability: metric points, tenant logs and spans, issues and incidents,
 * alert rules and their state, alerts, uptime checks and dashboards.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

export const observabilityTables = {
    // Exact metric measurements (the precise tier behind the Metrics UI). Every
    // `ctx.metrics.*` data point OTLP-ingested via `/v1/metrics` lands here as one
    // row, so the series read is exact per-bucket (all points averaged) — unlike the
    // Analytics-Engine mirror (`store.ts` `recordMetrics`), which is sampled +
    // bucket-approximated and now serves only as the >retention archive fallback.
    // Same 7-day hot window as span observations, pruned by `metrics.prune`.
    metricPoints: defineTable({
        // Measurement time (epoch ms) — the series x-axis; the AE mirror can't give exact points.
        at: v.number(),
        createdAt: v.number(),
        deploymentId: v.optional(v.id("deployments")),
        functionPath: v.optional(v.string()),
        kind: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        serviceName: v.optional(v.string()),
        value: v.number(),
    })
        .global()
        .index("by_org_at", ["organizationId", "at"])
        .index("by_org_name_at", ["organizationId", "name", "at"]),

    // Tenant runtime logs (GAPS.md B2): console/exception events batched in by
    // the dispatch-namespace tail worker via `POST /v1/logs/ingest`. Retention-
    // capped by the prune cron; the ingest seam can re-point to Analytics
    // Engine later without touching consumers.
    tenantLogs: defineTable({
        createdAt: v.number(),
        // Structured fields the line carried (`ctx.log.info(msg, fields)` /
        // `ctx.log.with(fields)`), already normalized to JSON-safe primitives by
        // the framework. Absent for a plain console-style line.
        fields: v.optional(v.record(v.string(), v.any())),
        // The function that emitted the line, e.g. `messages:list`; absent for
        // lines with no dispatch attribution.
        functionPath: v.optional(v.string()),
        // Full OpenTelemetry severity ramp — matches the framework's
        // `ContextLogLevel` so `debug`/`info`/`trace`/`fatal` survive (was
        // `log`/`warn`/`error` only).
        level: v.union(v.literal("trace"), v.literal("debug"), v.literal("info"), v.literal("log"), v.literal("warn"), v.literal("error"), v.literal("fatal")),
        // The rendered display string (was `line`).
        message: v.string(),
        organizationId: v.id("organizations"),
        scriptName: v.string(),
        // Shard key the line was emitted under, when sharded.
        shardKey: v.optional(v.string()),
        // Span id of the RPC this line belongs to — trace correlation.
        spanId: v.optional(v.string()),
        // Trace id (from the inbound `traceparent`) — links the line to its
        // dispatch trace and, for an error/fatal line, the OTLP-derived Issue.
        traceId: v.optional(v.string()),
        // Acting user, when known.
        userId: v.optional(v.string()),
    })
        .global()
        // Primary tail/list index: page a script's lines by time without an
        // in-isolate sort of the whole window.
        .index("by_script_time", ["scriptName", "createdAt"])
        // Fetch every line in a trace (log↔trace correlation), org-scoped.
        .index("by_trace", ["organizationId", "traceId"]),

    // Dispatch spans as **observations** (Traces, GAPS.md B2 — the span store the
    // Langfuse teardown pointed to). Every OTLP span (not just the error spans the
    // Issue path keeps) lands here with its real timing + identity, so the Traces
    // waterfall renders true durations and whatever nesting `parentSpanId` carries.
    // Retention-pruned like `tenantLogs`.
    observations: defineTable({
        // Selected `lunora.*` string span attributes (shard key, user id, …).
        attributes: v.optional(v.record(v.string(), v.string())),
        // Generation spans (`kind: "generation"`): completion token count.
        completionTokens: v.optional(v.number()),
        createdAt: v.number(),
        // The deployment the span ran under, when the sink forwarded it.
        deploymentId: v.optional(v.id("deployments")),
        // `endedAt − startedAt`, denormalized so the list/waterfall need no math.
        durationMs: v.number(),
        endedAt: v.number(),
        // Generation spans: eval scores decoded from `gen_ai.evaluation.*` (opt-in
        // on the emitter), rendered in the span-detail pane. Absent until the
        // framework's eval work lands.
        evaluations: v.optional(v.array(v.object({ label: v.optional(v.string()), name: v.string(), score: v.number() }))),
        // `<file>:<function>` (or `container:<name>`), when attributed.
        functionPath: v.optional(v.string()),
        // Generation spans: the recorded prompt/input (only when the emitter opted
        // into input recording — off by default), truncated.
        input: v.optional(v.string()),
        // Which instrumentation emitted the span. `generation` = an AI model call
        // (carries `gen_ai.*`), from `@lunora/ai`/`@lunora/agent`.
        kind: v.union(v.literal("container"), v.literal("generation"), v.literal("worker")),
        // `error` when the span's OTLP status was `STATUS_CODE_ERROR`, else `info`.
        level: v.union(v.literal("error"), v.literal("info")),
        // Generation spans: the model id (`gen_ai.request.model`).
        model: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        // Generation spans: the recorded completion/output (opt-in only), truncated.
        output: v.optional(v.string()),
        // Parent span, when the span nests; absent for a root span.
        parentSpanId: v.optional(v.string()),
        // Generation spans: prompt token count.
        promptTokens: v.optional(v.number()),
        serviceName: v.optional(v.string()),
        // Generation spans: the conversation/thread id (`gen_ai.conversation.id`)
        // that groups turns into a session (LLM sessions/threads view). Absent
        // until the framework emits it — no session id → no session grouping.
        sessionId: v.optional(v.string()),
        spanId: v.string(),
        startedAt: v.number(),
        // OTLP `status.message`, when the span errored.
        statusMessage: v.optional(v.string()),
        traceId: v.string(),
    })
        .global()
        // The drill-in: every span in one trace (the waterfall / tree), org-scoped.
        .index("by_trace", ["organizationId", "traceId"])
        // Recent spans, org-scoped, to roll up into the trace list newest-first.
        .index("by_org_started", ["organizationId", "startedAt"])
        // Every generation turn in one session — the sessions drill-in, org-scoped.
        .index("by_org_session", ["organizationId", "sessionId"])
        // Recent spans for ONE deployment — so a deployment-scoped trace list scans
        // that deployment's own spans (not the global recent window, where a quiet
        // deployment's older traces would fall off the end).
        .index("by_org_deployment_started", ["organizationId", "deploymentId", "startedAt"]),

    // Grouped application errors — the Cloud Observability "Issues" view. The
    // telemetry ingest (`POST /v1/telemetry`) fingerprints each error event
    // (function path + normalized message, via `@lunora/fingerprint`) and folds
    // it onto one row per (org, hash) — cross-deployment, and the *same* hash the
    // local Studio computes, so a local Issue and a cloud Issue are one object.
    // `count`/`lastSeen` grow as the same error recurs.
    issues: defineTable({
        count: v.number(),
        createdAt: v.number(),
        // What raised it — the function path (or `container:<name>` for a crash).
        culprit: v.string(),
        // Last deployment the error was seen on (metadata; the group is per-org).
        deploymentId: v.optional(v.id("deployments")),
        firstSeen: v.number(),
        // Stable 16-char grouping hash from `@lunora/fingerprint`.
        hash: v.string(),
        lastSeen: v.number(),
        organizationId: v.id("organizations"),
        // A representative raw message for the group (last seen).
        sampleMessage: v.string(),
        // A sample trace id (the latest error span's), to jump to the trace.
        sampleTraceId: v.optional(v.string()),
        status: v.union(v.literal("open"), v.literal("resolved")),
        title: v.string(),
        updatedAt: v.number(),
    })
        .global()
        // One issue per (org, hash); the ingest upserts through this index.
        .index("by_org_hash", ["organizationId", "hash"], { unique: true })
        // Errors grouped by what raised them — lets `incidents.triage` pull the
        // *other* error groups from a crashing container (culprit
        // `container:<name>`) without scanning the org's whole issue set.
        .index("by_org_culprit", ["organizationId", "culprit"]),

    // Higher-level incidents (crash-loop / OOM / error-spike) opened from
    // container lifecycle telemetry. Fingerprinted like issues (by container +
    // reason) so repeated crashes fold onto one open incident; resolved from the
    // dashboard (auto-resolve on a cleared pattern is a Phase 4 concern).
    incidents: defineTable({
        closedAt: v.optional(v.number()),
        // Container name, when the incident is container-sourced.
        container: v.optional(v.string()),
        count: v.number(),
        createdAt: v.number(),
        deploymentId: v.optional(v.id("deployments")),
        hash: v.string(),
        // Container DO instance id, when known.
        instance: v.optional(v.string()),
        // When the last investigation ran (`incidents.investigate`); absent until
        // one has. Distinct from `status` (open/resolved) — an incident can be
        // investigated while still open.
        investigatedAt: v.optional(v.number()),
        // The last structured investigation result (agentic runner output), stored
        // so the dashboard renders it without re-spending inference. Shape mirrors
        // `InvestigationResult` (src/telemetry/investigation.ts).
        investigation: v.optional(
            v.object({
                by: v.union(v.literal("deterministic"), v.literal("llm")),
                confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
                evidenceNote: v.string(),
                relatedTraceIds: v.array(v.string()),
                rootCauseHypothesis: v.string(),
                suggestedRemediation: v.string(),
                summary: v.string(),
            }),
        ),
        kind: v.union(v.literal("crash_loop"), v.literal("oom"), v.literal("error_spike")),
        lastSeen: v.number(),
        openedAt: v.number(),
        organizationId: v.id("organizations"),
        status: v.union(v.literal("open"), v.literal("resolved")),
        title: v.string(),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org_hash", ["organizationId", "hash"], { unique: true }),

    // Alert rules (Observability "watches while you sleep"). Two firing models:
    //  • Count-crossing targets (`issue`/`incident`/`uptime`) fire once when a
    //    monotone counter first reaches `threshold`.
    //  • Metric-window targets (`error_rate`/`latency_p95`/`llm_cost`) compute an
    //    app-semantic / budget value over the last `windowMinutes` of span
    //    observations and fire (edge-triggered) when it breaches `threshold`
    //    under `comparator`. Optionally scoped to one `functionPath`.
    // Configured from the dashboard; evaluated (pure) inside the telemetry ingest
    // (metric rules) / uptime sweep (uptime).
    alertRules: defineTable({
        // `mode: "deviation"` only: how many `windowMinutes`-long windows before
        // the current one average into the baseline. Absent ⇒ 7.
        baselineWindows: v.optional(v.number()),
        // Delivery channel. `email` via the mailer; `webhook`/`slack`/`pagerduty`
        // are typed JSON POSTs (Slack incoming-webhook JSON, PagerDuty Events v2).
        channel: v.union(v.literal("email"), v.literal("webhook"), v.literal("slack"), v.literal("pagerduty")),
        // How the metric value is compared to `threshold` (metric targets only).
        // Absent ⇒ `gt`; irrelevant for count-crossing targets.
        comparator: v.optional(v.union(v.literal("gt"), v.literal("lt"))),
        createdAt: v.number(),
        // Email address (channel "email") or URL (channel "webhook").
        destination: v.string(),
        enabled: v.boolean(),
        // Optional scope for a metric rule: evaluate only spans from this
        // function path (e.g. `messages:send`). Absent ⇒ the whole org.
        functionPath: v.optional(v.string()),
        // How a metric rule decides it is breaching. `threshold` (absent ⇒ this)
        // compares the window value to `threshold` directly — right when the
        // number has an absolute meaning (an SLO, a spend cap). `deviation`
        // compares the window value to its own trailing baseline and reads
        // `threshold` as a percent change — right for usage and cost signals,
        // where a static threshold either fires constantly or never fires until
        // the bill lands, because "normal" is whatever last week was.
        mode: v.optional(v.union(v.literal("threshold"), v.literal("deviation"))),
        name: v.string(),
        organizationId: v.id("organizations"),
        // What the rule watches. Count-crossing: `issue`/`incident` (a fingerprint
        // group's event count), `uptime` (a deployment's consecutive failed
        // synthetic checks, see lunora/uptime.ts). Metric-window: `error_rate`
        // (% error spans), `latency_p95` (p95 durationMs), `llm_cost` (summed
        // generation cost) over `windowMinutes`. Event: `deploy` (a build or a
        // deployment failed) — it carries
        // no threshold, because a failed release is not a quantity that crosses a
        // line, it is one thing that happened.
        target: v.union(
            v.literal("issue"),
            v.literal("incident"),
            v.literal("uptime"),
            v.literal("error_rate"),
            v.literal("latency_p95"),
            v.literal("llm_cost"),
            v.literal("deploy"),
        ),
        // Count-crossing: fire when the source's count first reaches this value.
        // Metric-window: the value the window metric is compared against.
        threshold: v.number(),
        updatedAt: v.number(),
        // Rolling window length for a metric target, in minutes. Required for
        // metric targets; ignored for count-crossing targets.
        windowMinutes: v.optional(v.number()),
    })
        .global()
        .index("by_org", ["organizationId"]),

    // Per-rule firing state for METRIC-window rules (error_rate/latency_p95/llm_cost)
    // — the level-triggered latch behind the alert sweep (src/telemetry/sweep.ts),
    // analogous to `uptimeState` for uptime. A metric rule's window value rises and
    // falls, so — unlike a monotone count crossing — it needs remembered state to
    // fire once on a breach and re-arm on recovery. Both the ingest path and the
    // periodic sweep read/advance this latch, so a sustained breach alerts once and
    // a window that goes quiet still clears (and can fire again later). One row per
    // rule; count-crossing/uptime rules don't use it.
    alertRuleState: defineTable({
        createdAt: v.number(),
        // `true` while the rule's window is over threshold (already alerted).
        firing: v.boolean(),
        // When the sweep/ingest last evaluated this rule (freshness/debugging).
        lastEvaluatedAt: v.number(),
        // The window metric value at the last evaluation (audit/debugging).
        lastValue: v.number(),
        organizationId: v.id("organizations"),
        ruleId: v.id("alertRules"),
        updatedAt: v.number(),
    })
        .global()
        // One state row per rule; the ingest/sweep upsert through this index.
        .index("by_rule", ["ruleId"], { unique: true })
        .index("by_org", ["organizationId"]),

    // Fired alerts — the audit trail + delivery state for each rule trip. The
    // ingest inserts a `firing` row (with the notification denormalized so the
    // edge needs no re-read); the edge delivers it (email/webhook) and stamps it
    // `delivered`/`failed`. The dashboard lists recent alerts per org.
    alerts: defineTable({
        // Rendered notification content, denormalized at fire time.
        body: v.string(),
        channel: v.union(v.literal("email"), v.literal("webhook"), v.literal("slack"), v.literal("pagerduty")),
        createdAt: v.number(),
        deliveredAt: v.optional(v.number()),
        destination: v.string(),
        // Fingerprint of what tripped the rule: the issue/incident hash, or — for a
        // `deploy` alert — the failing build/deployment id, which is what makes a
        // re-fire for the same release identifiable.
        hash: v.string(),
        organizationId: v.id("organizations"),
        ruleId: v.id("alertRules"),
        status: v.union(v.literal("firing"), v.literal("delivered"), v.literal("failed")),
        subject: v.string(),
        target: v.union(
            v.literal("issue"),
            v.literal("incident"),
            v.literal("uptime"),
            v.literal("error_rate"),
            v.literal("latency_p95"),
            v.literal("llm_cost"),
            v.literal("deploy"),
        ),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_status", ["status"]),

    // Synthetic uptime — one row per external probe of a live deployment's URL,
    // written by the every-minute uptime sweep (src/uptime/sweep.ts). A bounded,
    // pruned time series (lunora/uptime.ts `prune`) that backs the Uptime page's
    // status + latency timeline. The probe runs from the control plane, an
    // external vantage point a deployment can't self-report from.
    uptimeChecks: defineTable({
        createdAt: v.number(),
        deploymentId: v.id("deployments"),
        // Transport/timeout error message, when the probe never got a response.
        error: v.optional(v.string()),
        // Round-trip time of the probe, in ms.
        latencyMs: v.optional(v.number()),
        // `true` when the deployment answered with an HTTP status below 500.
        ok: v.boolean(),
        organizationId: v.id("organizations"),
        statusCode: v.optional(v.number()),
    })
        // Written by the every-minute synthetic-uptime sweep in `src/uptime/sweep.ts`
        // (control-plane `scheduled()`), not by any lunora/ mutation — so no
        // `ctx.db.insert` is discoverable for it.
        .externallyManaged()
        .global()
        .index("by_org_deployment", ["organizationId", "deploymentId"]),

    // Per-deployment uptime state — the running consecutive-failure counter the
    // sweep advances each tick, so an uptime alert fires exactly once when the
    // count first crosses a rule's threshold (crossesThreshold), not every tick
    // the deployment stays down. One row per deployment.
    uptimeState: defineTable({
        // Failed checks in a row; reset to 0 on the first success.
        consecutiveFailures: v.number(),
        createdAt: v.number(),
        deploymentId: v.id("deployments"),
        lastCheckedAt: v.number(),
        lastOk: v.boolean(),
        organizationId: v.id("organizations"),
        updatedAt: v.number(),
    })
        // Same writer as `uptimeChecks`: the sweep advances this row directly.
        .externallyManaged()
        .global()
        .index("by_deployment", ["deploymentId"])
        .index("by_org", ["organizationId"]),

    // User-defined custom dashboards (Tier 2 observability). A named, per-org
    // collection of saved panels — each panel a saved query over telemetry the
    // console already serves (a metric trend, a single-stat number, or a saved
    // Traces/Logs filter shortcut). Grafana-style boards composed from the
    // existing read paths; no new telemetry backend. Panels are stored inline as
    // a JSON array (low cardinality, always read whole with the board).
    dashboards: defineTable({
        createdAt: v.number(),
        name: v.string(),
        organizationId: v.id("organizations"),
        // Ordered panels. `kind` selects the widget; `config` carries only the
        // keys that kind uses (`metricName` for metric/stat, `stat` for a stat's
        // aggregation, `filter` for a traces/logs deep-link shortcut).
        panels: v.array(
            v.object({
                config: v.object({
                    filter: v.optional(v.string()),
                    metricName: v.optional(v.string()),
                    stat: v.optional(v.union(v.literal("last"), v.literal("first"), v.literal("count"))),
                }),
                id: v.string(),
                kind: v.union(v.literal("metric"), v.literal("stat"), v.literal("traces"), v.literal("logs")),
                title: v.string(),
            }),
        ),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"]),
};
