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
        // hosted-studio admin proxy (§3) call its /_lunora/admin/*. Should be
        // envelope-encrypted at rest (§7) — stored plain here for the scaffold.
        adminToken: v.optional(v.string()),
        // Stable (unversioned) script label — the project's public subdomain.
        // The dispatcher resolves alias → the project's active versioned script.
        alias: v.optional(v.string()),
        // Preview deployments carry the originating git branch (§2.3).
        branch: v.optional(v.string()),
        // The tenant's compiled cron expressions (wrangler `triggers.crons`). WfP
        // drops cron triggers for namespaced workers, so the control plane fans
        // ticks out to these from its own `scheduled()` (§2.4 / src/fanout).
        cronSpecs: v.optional(v.array(v.string())),
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
    })
        .global()
        // Dispatcher resolves a stable alias → the project's active script.
        .index("by_alias", ["alias"])
        .index("by_kind", ["kind"])
        .index("by_project", ["projectId"])
        // Dispatcher resolves a request's script id → org plan via this index.
        .index("by_script", ["scriptName"]),

    deployKeys: defineTable({
        createdAt: v.number(),
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

    // Tenant runtime logs (GAPS.md B2): console/exception events batched in by
    // the dispatch-namespace tail worker via `POST /v1/logs/ingest`. Retention-
    // capped by the prune cron; the ingest seam can re-point to Analytics
    // Engine later without touching consumers.
    tenantLogs: defineTable({
        createdAt: v.number(),
        level: v.union(v.literal("log"), v.literal("warn"), v.literal("error")),
        line: v.string(),
        organizationId: v.id("organizations"),
        scriptName: v.string(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_script", ["scriptName"]),

    // GitHub App installations (GAPS.md A4): which org a GitHub App install
    // belongs to; push webhooks are scoped to the triggering installation.
    githubInstallations: defineTable({
        accountLogin: v.string(),
        createdAt: v.number(),
        installationId: v.number(),
        organizationId: v.id("organizations"),
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
        .index("by_project", ["projectId"])
        .index("by_project_commit", ["projectId", "commitSha"]),

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
        .index("by_build", ["buildId"]),

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

    // Tenant environment secrets (§7). Stored AES-256-GCM encrypted at the edge
    // (`src/secrets/crypto.ts`) — only ciphertext + IV live here. Materialized +
    // decrypted at deploy time into the tenant Worker's script secrets.
    secrets: defineTable({
        ciphertext: v.string(),
        createdAt: v.number(),
        iv: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        updatedAt: v.number(),
    })
        .global()
        .index("by_project", ["projectId"])
        .index("by_project_name", ["projectId", "name"], { unique: true }),

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
        .global()
        .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
        .index("by_reference", ["referenceId"]),

    events: defineTable({
        processedAt: v.number(),
        provider: v.string(),
        providerEventId: v.string(),
        type: v.string(),
    })
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
        .global()
        .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
        .index("by_reference_feature", ["referenceId", "featureId"]),
});
