import { defineSchema, defineTable, v } from "@lunora/server";

/**
 * Lunora Cloud control-plane data model — see `CLOUD-PLAN.md` (§2.2 control
 * plane, §2.5 cells). This is the *platform's* own schema, dogfooded on Lunora
 * itself (the platform's metadata store is a Lunora app).
 *
 * Every table is `.global()` (D1-backed): the control plane is the "Worker + D1"
 * service of the plan, and its bookkeeping is relational, cross-queried, and low
 * volume relative to tenant app data. (Per-tenant *sharding* in the plan refers
 * to the tenant apps' own ShardDOs, not the control plane's metadata.) Reads use
 * the per-table `findMany({ where })` facade; the fluent `query()` / `withIndex()`
 * reader is not available on the D1 backend.
 */

const plan = v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"));

const cellStatus = v.union(v.literal("active"), v.literal("draining"), v.literal("suspended"));

const memberRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer"));

const deploymentKind = v.union(v.literal("production"), v.literal("preview"), v.literal("dev"));

const deploymentStatus = v.union(
    v.literal("queued"),
    v.literal("provisioning"),
    v.literal("building"),
    v.literal("verifying"),
    v.literal("live"),
    v.literal("superseded"),
    v.literal("failed"),
    v.literal("destroyed"),
);

const deployKeyType = v.union(v.literal("production"), v.literal("dev"), v.literal("preview"));

export default defineSchema({
    cells: defineTable({
        // The Cloudflare account this cell runs in. Each cell isolates per-account
        // limits + blast radius (§2.5).
        cloudflareAccountId: v.string(),
        createdAt: v.number(),
        // Dispatch-namespace base; per env we derive `${prefix}-production`, etc.
        dispatchNamespacePrefix: v.string(),
        // "eu" | "fedramp" | undefined — DO/R2 jurisdiction for this cell (§2.4).
        jurisdiction: v.optional(v.string()),
        name: v.string(),
        status: cellStatus,
        // Metering readback checkpoint (§4): the epoch-ms boundary this cell has
        // folded Analytics-Engine request counts into `platformUsage` through.
        // The rollback reads AE for `timestamp > usageReadAtMs`, so repeated runs
        // never double-count the same requests.
        usageReadAtMs: v.optional(v.number()),
    })
        .global()
        .index("by_name", ["name"], { unique: true }),

    organizations: defineTable({
        cellId: v.id("cells"),
        createdAt: v.number(),
        name: v.string(),
        plan,
        slug: v.string(),
        // Aggregate period spend cap in minor units (GAPS.md C1). Unset = the
        // plan default; explicit 0 = uncapped (support escape hatch).
        spendCapMinor: v.optional(v.number()),
        // Set by the spend-cap or dunning enforcement crons (or support); the
        // dispatcher serves 503 for a suspended org's tenants.
        suspendedAt: v.optional(v.number()),
        // Which mechanism suspended the org ("spend-cap" | "dunning" |
        // "support"); each cron only lifts its own suspensions.
        suspendedReason: v.optional(v.string()),
        // Dunning (GAPS.md C2): when payment failure was first observed; the
        // grace window measures from here.
        paymentFailedAt: v.optional(v.number()),
        // Creem credits-account id (prepaid overage, GAPS.md C3): set when the
        // first credit pack is purchased; the reconciliation debits against it.
        creditsAccountId: v.optional(v.string()),
        // Right-to-erasure (GAPS.md D3): an owner requested deletion; the purge
        // cron erases the org's data once the retention window passes.
        deletionRequestedAt: v.optional(v.number()),
    })
        .global()
        .index("by_slug", ["slug"], { unique: true }),

    members: defineTable({
        createdAt: v.number(),
        organizationId: v.id("organizations"),
        role: memberRole,
        // External identity id (from the platform auth provider).
        userId: v.string(),
    })
        .global()
        .index("by_org_user", ["organizationId", "userId"]),

    projects: defineTable({
        // Blue/green pointer (GAPS.md A1): the deployment currently serving the
        // project's stable URL. Swapped only after a health-checked release;
        // rollback is a swap back to a retained superseded deployment. A plain
        // string (not v.id) deliberately: projects ↔ deployments would otherwise
        // be circularly typed in the generated Drizzle schema.
        activeDeploymentId: v.optional(v.string()),
        // Denormalized script id of the active deployment, so the dispatcher's
        // route lookup resolves alias → script in one read.
        activeScriptName: v.optional(v.string()),
        createdAt: v.number(),
        // Optional meta-framework hint (tanstack-start, astro, …) for the build step.
        framework: v.optional(v.string()),
        // Connected GitHub repository (`owner/name`) for preview automation (§2.3).
        githubRepo: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        slug: v.string(),
    })
        .global()
        .index("by_github_repo", ["githubRepo"])
        // Per-org slug uniqueness, enforced by the composite unique index.
        .index("by_org_slug", ["organizationId", "slug"], { unique: true }),

    deployments: defineTable({
        // Tenant admin bearer the platform set on the deployed worker; lets the
        // hosted-studio admin proxy (§3) call its /_lunora/admin/*. Sealed at rest
        // with SECRET_ENCRYPTION_KEY (§7): ciphertext + IV below. `adminToken`
        // (plaintext) is the dev-only fallback written when no master key is set.
        adminToken: v.optional(v.string()),
        adminTokenCiphertext: v.optional(v.string()),
        adminTokenIv: v.optional(v.string()),
        // Stable (unversioned) script label — the project's public subdomain.
        // The dispatcher resolves alias → the project's active versioned script.
        alias: v.optional(v.string()),
        // Preview deployments carry the originating git branch (§2.3).
        branch: v.optional(v.string()),
        // The tenant's compiled cron expressions (wrangler `triggers.crons`). WfP
        // drops cron triggers for namespaced workers, so the control plane fans
        // ticks out to these from its own `scheduled()` (§2.4 / src/fanout).
        cronSpecs: v.optional(v.array(v.string())),
        // The Cloudflare resources this deployment's wrangler config binds, captured
        // at deploy time so the studio can render the binding graph without reaching
        // into the tenant's script. `type` is the wrangler kind (d1/kv/r2/queue/ai/
        // durable_object/secret/var), `target` the concrete resource it points at.
        bindings: v.optional(v.array(v.object({ name: v.string(), target: v.optional(v.string()), type: v.string() }))),
        // Content hash of the uploaded worker bundle; rollback re-converges to a
        // prior hash retained in R2 (§2.2).
        bundleHash: v.optional(v.string()),
        createdAt: v.number(),
        createdBy: v.string(),
        // Preview deployments expire (TTL); the cleanup cron tears them down (§2.3).
        expiresAt: v.optional(v.number()),
        kind: deploymentKind,
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        // Dispatch-namespace script id this deployment provisioned. Versioned
        // per release (`{alias}-v{version}`) so every deployment is immutable
        // and rollback is a pointer swap (GAPS.md A1).
        scriptName: v.string(),
        status: deploymentStatus,
        updatedAt: v.number(),
        url: v.optional(v.string()),
        // Monotonic release number per (project, kind).
        version: v.optional(v.number()),
        // @lunora/runtime version bundled into this release (GAPS.md E4) — the
        // fleet-upgrade planner targets deployments pinned below the fleet
        // minimum for forced re-release.
        runtimeVersion: v.optional(v.string()),
        // Phase-transition timestamps (GAPS.md A2) — status history for free.
        queuedAt: v.optional(v.number()),
        provisioningAt: v.optional(v.number()),
        verifyingAt: v.optional(v.number()),
        liveAt: v.optional(v.number()),
        supersededAt: v.optional(v.number()),
        failedAt: v.optional(v.number()),
        destroyedAt: v.optional(v.number()),
        // Set when the teardown sweep has actually removed the Cloudflare
        // dispatch script (GAPS.md A1 / §2.3). `destroyedAt` records the
        // lifecycle transition; `teardownAt` records that the real resource is
        // gone — the sweep only acts on `destroyed` rows where this is unset, so
        // it is crash-safe idempotent (a re-run tears down nothing twice).
        teardownAt: v.optional(v.number()),
    })
        .global()
        // Dispatcher resolves a stable alias → the project's active script.
        .index("by_alias", ["alias"])
        .index("by_kind", ["kind"])
        .index("by_project", ["projectId"])
        // Dispatcher resolves a request's script id → org plan via this index.
        .index("by_script", ["scriptName"]),

    // One-row-per-alias ownership ledger. An alias (the tenant's stable script
    // label) seeds per-deployment D1/R2 resource names + alias→script routing, so
    // it MUST belong to exactly one project. `deployments.alias` repeats across a
    // project's versioned releases, so it can't carry a unique index itself; this
    // side table does, giving the claim DB-level atomicity — two concurrent first
    // deploys of the same alias by different projects can't both win the check
    // (the losing insert violates `by_alias` unique), closing the create() TOCTOU.
    aliasOwnership: defineTable({
        alias: v.string(),
        createdAt: v.number(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    })
        .global()
        .index("by_alias", ["alias"], { unique: true })
        .index("by_project", ["projectId"]),

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

    deployKeys: defineTable({
        // What the key is allowed to do. Absent = `deploy` (a full deploy key, the
        // historical default). An `ingest` key can ONLY push telemetry to the OTLP
        // endpoints — it is rejected by the deploy/admin paths — so the token the
        // platform injects into a tenant's `otlpSink` can't be used to deploy.
        capability: v.optional(v.union(v.literal("deploy"), v.literal("ingest"))),
        createdAt: v.number(),
        // Envelope-encrypted plaintext (AES-256-GCM). ONLY set for platform-managed
        // `ingest` keys, so the deploy path can re-inject the token into a tenant's
        // `otlpSink` on every deploy without re-minting. User deploy keys never
        // store this — their plaintext is shown once and is unrecoverable.
        encryptedSecret: v.optional(v.object({ ciphertext: v.string(), iv: v.string() })),
        // Only the hash is stored; the plaintext key is shown once at creation.
        hashedKey: v.string(),
        lastUsedAt: v.optional(v.number()),
        name: v.string(),
        organizationId: v.id("organizations"),
        // A preview/dev key may be scoped to a single project, or org-wide.
        projectId: v.optional(v.id("projects")),
        revokedAt: v.optional(v.number()),
        type: deployKeyType,
    })
        .global()
        .index("by_hash", ["hashedKey"], { unique: true })
        .index("by_org", ["organizationId"]),

    // Overage-debit watermarks (GAPS.md C3 follow-up): cumulative credits
    // already debited from the org's Creem prepaid-credits account per billing
    // period. The reconciliation loop debits only the delta between credits
    // owed (from platformUsage) and this watermark, with an idempotent
    // reference, so re-runs and crashes never double-charge.
    overageDebits: defineTable({
        debitedCredits: v.number(),
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org_period", ["organizationId", "periodStart"], { unique: true }),

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

    // GitHub App installations (GAPS.md A4). Two-phase: the webhook *stages* an
    // installation (no org linkage — a spoofed call is harmless), then an org
    // owner/admin *claims* it from the dashboard. Push-to-deploy only accepts
    // pushes whose installation is claimed by the project's org.
    githubInstallations: defineTable({
        accountLogin: v.string(),
        claimedAt: v.optional(v.number()),
        createdAt: v.number(),
        installationId: v.number(),
        // Set at claim time (owner/admin session), never by the webhook.
        organizationId: v.optional(v.id("organizations")),
    })
        .global()
        .index("by_installation", ["installationId"], { unique: true })
        .index("by_org", ["organizationId"]),

    // Server-side builds (GAPS.md A3): a push (or PR) creates a build; the
    // runner claims it via a lease, streams lines into buildLogs, and hands the
    // bundle to the deploy pipeline. Dedup: a successful build for the same
    // (project, commitSha) is reused instead of rebuilt.
    builds: defineTable({
        branch: v.string(),
        bundleHash: v.optional(v.string()),
        commitSha: v.string(),
        createdAt: v.number(),
        // The deployment this build fed, once deployed.
        deploymentId: v.optional(v.string()),
        error: v.optional(v.string()),
        organizationId: v.id("organizations"),
        // Work lease: which runner is on it and since when (stale after 30 min).
        processingBy: v.optional(v.string()),
        processingStartedAt: v.optional(v.number()),
        projectId: v.id("projects"),
        status: v.union(v.literal("pending"), v.literal("building"), v.literal("successful"), v.literal("failed")),
        updatedAt: v.number(),
        // Phase timestamps (A2 pattern).
        buildingAt: v.optional(v.number()),
        successfulAt: v.optional(v.number()),
        failedAt: v.optional(v.number()),
    })
        .global()
        .index("by_project_commit", ["projectId", "commitSha"])
        // `purgeDeleted` filters this table by `organizationId`; without the index
        // each org-deletion sweep degrades into a full scan of every build ever run.
        .index("by_org", ["organizationId"]),

    // Streamed build output, one row per line (GAPS.md A3); the dashboard tails
    // a build live. Pruned with the retention cron.
    buildLogs: defineTable({
        buildId: v.id("builds"),
        createdAt: v.number(),
        level: v.union(v.literal("info"), v.literal("error")),
        line: v.string(),
        organizationId: v.id("organizations"),
    })
        .global()
        .index("by_build", ["buildId"])
        // Same reason as `builds.by_org` — the purge sweep filters on it.
        .index("by_org", ["organizationId"]),

    // Custom domains (GAPS.md B1). A hostname routes to a project's active
    // deployment once DNS-verified; cert issuance (Cloudflare for SaaS) is only
    // requested for verified rows — DB-gated on-demand TLS.
    domains: defineTable({
        // Cloudflare for SaaS custom-hostname id, once provisioned (🌐 path).
        customHostnameId: v.optional(v.string()),
        createdAt: v.number(),
        hostname: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        // Redirect-only domains (e.g. apex → www): no routing, just a redirect.
        redirectStatusCode: v.optional(v.number()),
        redirectTo: v.optional(v.string()),
        // Expected value of the `_lunora.<hostname>` TXT record.
        txtToken: v.string(),
        updatedAt: v.number(),
        verifiedAt: v.optional(v.number()),
    })
        .global()
        .index("by_hostname", ["hostname"], { unique: true })
        .index("by_project", ["projectId"]),

    auditLog: defineTable({
        action: v.string(),
        actorUserId: v.string(),
        createdAt: v.number(),
        organizationId: v.id("organizations"),
        target: v.optional(v.string()),
    })
        .global()
        .index("by_org", ["organizationId"]),

    invitations: defineTable({
        createdAt: v.number(),
        email: v.string(),
        expiresAt: v.number(),
        invitedBy: v.string(),
        organizationId: v.id("organizations"),
        role: memberRole,
        status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
        // SHA-256 of the invite token; the plaintext is mailed once, never stored.
        tokenHash: v.string(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_token", ["tokenHash"], { unique: true }),

    // Platform resource-metering events (§4), summed per org per billing period
    // for quota + overage billing. Written by the platform metering ingestion
    // endpoint (`POST /v1/usage`) and the Analytics-Engine stream. Distinct from
    // the `@lunora/payment` `usageEvents` ledger below (which meters *billing*
    // features); this one meters platform resources (requests/CPU/storage).
    platformUsage: defineTable({
        createdAt: v.number(),
        deploymentId: v.optional(v.id("deployments")),
        kind: v.union(v.literal("requests"), v.literal("cpuMs"), v.literal("storageBytes")),
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"]),

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
        name: v.string(),
        organizationId: v.id("organizations"),
        // What the rule watches. Count-crossing: `issue`/`incident` (a fingerprint
        // group's event count), `uptime` (a deployment's consecutive failed
        // synthetic checks, see lunora/uptime.ts). Metric-window: `error_rate`
        // (% error spans), `latency_p95` (p95 durationMs), `llm_cost` (summed
        // generation cost) over `windowMinutes`.
        target: v.union(
            v.literal("issue"),
            v.literal("incident"),
            v.literal("uptime"),
            v.literal("error_rate"),
            v.literal("latency_p95"),
            v.literal("llm_cost"),
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
        // Fingerprint hash of the issue/incident that tripped the rule.
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

    // Tenant environment secrets (§7). Stored AES-256-GCM encrypted at the edge
    // (`src/secrets/crypto.ts`) — only ciphertext + IV live here. Materialized +
    // decrypted at deploy time into the tenant Worker's script secrets.
    secrets: defineTable({
        ciphertext: v.string(),
        createdAt: v.number(),
        // Which deployment kind sees this secret; "all" is shared across
        // environments and overridden by a kind-specific row of the same name.
        environment: v.union(v.literal("all"), v.literal("production"), v.literal("preview"), v.literal("dev")),
        iv: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        updatedAt: v.number(),
    })
        .global()
        .index("by_project_env_name", ["projectId", "environment", "name"], { unique: true }),

    // Per-org BYO Cloudflare billing connection (Billable Usage API). Stores the
    // org's *own* Cloudflare account id + an AES-256-GCM-encrypted API token with
    // the Billing Read scope (same edge-encryption path as `secrets`, so only
    // ciphertext + IV live here — never the token). `cloudflareBilling.summary`
    // decrypts it at the edge to read that account's real billable usage, so a
    // BYO-Cloudflare org sees its actual Cloudflare spend by product, not the
    // control plane's *estimate* (`src/billing/spend.ts`). One row per org.
    cloudflareBilling: defineTable({
        cloudflareAccountId: v.string(),
        ciphertext: v.string(),
        createdAt: v.number(),
        iv: v.string(),
        organizationId: v.id("organizations"),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"], { unique: true }),

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

    // ── @lunora/payment tables (§4 billing) ───────────────────────────────────
    // Declared inline (codegen parses this file's AST and can't resolve a cross-
    // package `...paymentTables` spread). `@lunora/payment`'s exported
    // `paymentTables` is the canonical column reference these mirror; the payment
    // store reads/writes them via `ctx.payments`. All `.global()` so billing state
    // lives in the control-plane D1 alongside the org metadata it keys on
    // (referenceId === organizations._id).
    customers: defineTable({
        createdAt: v.number(),
        email: v.optional(v.string()),
        provider: v.string(),
        providerCustomerId: v.string(),
        referenceId: v.string(),
    })
        // The `@lunora/payment` store writes these rows through `ctx.payments`
        // (checkout + webhook sync), never via a `ctx.db.insert` in lunora/.
        .externallyManaged()
        .global()
        .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
        .index("by_reference", ["referenceId"]),

    events: defineTable({
        processedAt: v.number(),
        provider: v.string(),
        providerEventId: v.string(),
        type: v.string(),
    })
        // Written by the `@lunora/payment` webhook sync (see `customers`).
        .externallyManaged()
        .global()
        .index("by_provider_event", ["provider", "providerEventId"], { unique: true }),

    paymentSessions: defineTable({
        amountMinor: v.bigint(),
        capturedMinor: v.bigint(),
        createdAt: v.number(),
        currency: v.string(),
        provider: v.string(),
        providerSessionId: v.string(),
        referenceId: v.string(),
        refundedMinor: v.bigint(),
        state: v.string(),
        updatedAt: v.number(),
    })
        // Written by the `@lunora/payment` checkout flow (see `customers`).
        .externallyManaged()
        .global()
        .index("by_provider_session", ["provider", "providerSessionId"], { unique: true })
        .index("by_reference", ["referenceId"]),

    subscriptions: defineTable({
        cancelAtPeriodEnd: v.boolean(),
        createdAt: v.number(),
        currentPeriodEnd: v.optional(v.number()),
        currentPeriodStart: v.optional(v.number()),
        priceId: v.string(),
        provider: v.string(),
        providerSubscriptionId: v.string(),
        quantity: v.number(),
        referenceId: v.string(),
        state: v.string(),
        updatedAt: v.number(),
    })
        // Written by the `@lunora/payment` webhook sync (see `customers`).
        .externallyManaged()
        .global()
        .index("by_provider_subscription", ["provider", "providerSubscriptionId"], { unique: true })
        .index("by_reference", ["referenceId"]),

    // Metered-usage ledger backing `ctx.payments.track` / `check` (billing
    // features). Separate from `platformUsage` above (platform resources).
    usageEvents: defineTable({
        createdAt: v.number(),
        featureId: v.string(),
        idempotencyKey: v.string(),
        provider: v.string(),
        quantity: v.number(),
        referenceId: v.string(),
        reportedToProvider: v.boolean(),
    })
        // Written by `ctx.payments.track` metered-usage reporting (see `customers`).
        .externallyManaged()
        .global()
        .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
        .index("by_reference_feature", ["referenceId", "featureId"]),

    // Token-bucket state for the RPC rate limiter (`lunora/guards.ts`), one row
    // per (bucket, caller). Deliberately the only NON-`.global()` table in this
    // schema: it lives in the control-plane Durable Object's SQLite rather than
    // D1. Two reasons — `createDbStore` does a read-then-write per call, which is
    // atomic only under the DO's input gate (a D1 round-trip from a Worker-side
    // action would race and under-count), and the ingest path would otherwise pay
    // a D1 write per telemetry batch. Shape is fixed by `@lunora/ratelimit`'s
    // database store.
    rateLimits: defineTable({
        key: v.string(),
        prev: v.optional(v.number()),
        ts: v.number(),
        value: v.number(),
    })
        // `@lunora/ratelimit`'s store owns every row here — the canonical
        // `.externallyManaged()` case named in the builder's own docs.
        .externallyManaged()
        .index("by_key", ["key"]),
});
