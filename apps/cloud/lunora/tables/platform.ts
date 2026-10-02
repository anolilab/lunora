/**
 * The platform's own topology and people: cells, organizations and their
 * members, projects, invitations, the audit log, GitHub installations and
 * rate-limit buckets.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

import { deployTarget, memberRole, plan } from "./shared";

const cellStatus = v.union(v.literal("active"), v.literal("draining"), v.literal("suspended"));

export const platformTables = {
    cells: defineTable({
        // `cloudflare-wfp` encoding: the Cloudflare account this cell runs in.
        // Each cell isolates per-account limits + blast radius (§2.5). Kept as a
        // column for the rows that predate `config`; a new target's fields go in
        // `config`, never in a new column here (MULTIPLATFORM.md §5.2).
        cloudflareAccountId: v.string(),
        // Target-specific settings for this cell (region, credentials ref, …) —
        // the one place a non-WfP target keeps what it needs. String values only.
        config: v.optional(v.record(v.string(), v.string())),
        createdAt: v.number(),
        // `cloudflare-wfp` encoding: the dispatch-namespace base; per env we
        // derive `${prefix}-production`, etc.
        dispatchNamespacePrefix: v.string(),
        // "eu" | "fedramp" | undefined — DO/R2 jurisdiction for this cell (§2.4).
        jurisdiction: v.optional(v.string()),
        name: v.string(),
        status: cellStatus,
        // The target this cell's capacity serves; absent → `cloudflare-wfp`,
        // which every cell registered before targets is.
        target: v.optional(deployTarget),
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
        .index("by_org_user", ["organizationId", "userId"])
        // `organizations.list` resolves "which orgs is this person in" on every
        // dashboard load. The composite above leads with `organizationId`, so it
        // cannot serve a filter on `userId` alone — that read scanned the whole
        // membership table for every signed-in request.
        .index("by_user", ["userId"]),

    projects: defineTable({
        // The production release currently on the project's Worker (GAPS.md A1):
        // moved by a health-checked deploy or a rollback, which re-provisions a
        // retained release's stored bundle. A plain string (not v.id)
        // deliberately: projects ↔ deployments would otherwise be circularly
        // typed in the generated Drizzle schema.
        activeDeploymentId: v.optional(v.string()),
        // The project's production script (its alias), so a custom domain
        // resolves to it in one read.
        activeScriptName: v.optional(v.string()),
        createdAt: v.number(),
        // Optional meta-framework hint (tanstack-start, astro, …) for the build step.
        framework: v.optional(v.string()),
        // Connected GitHub repository (`owner/name`) for preview automation (§2.3).
        githubRepo: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        // Deployment protection for this project's PREVIEW deployments. A preview
        // URL is publicly addressable the moment it exists, which is the point —
        // you paste it to a colleague — but it also serves unreleased work to
        // anyone who is forwarded the link. Presence of a hash turns the gate on.
        // Salted SHA-256; the plaintext is never stored and never leaves the
        // browser that set it.
        previewPasswordHash: v.optional(v.string()),
        previewPasswordSalt: v.optional(v.string()),
        // The alias the project's first production release takes, claimed in
        // `aliasOwnership` when the project was created
        // (`src/deploy/production-alias.ts`), so it cannot collide with another
        // organization's. Absent on projects that predate it, which keep the
        // alias they deploy to (`activeScriptName`).
        productionAlias: v.optional(v.string()),
        // Monorepo support: the directory the build runs in, repo-relative and
        // normalized (absent = repo root), and the globs a push must touch to
        // rebuild (absent = everything under rootDirectory). See src/builds/paths.ts.
        rootDirectory: v.optional(v.string()),
        slug: v.string(),
        // Where this project deploys (`src/targets/registry.ts`). A property of
        // the project, never of a deploy request. Absent → `cloudflare-wfp`,
        // in the org's cell — which is what every project before targets did.
        target: v.optional(deployTarget),
        // The customer box a `celld-vps` project deploys to (plan 458 G12).
        // Required when `target` is `celld-vps` and absent otherwise — enforced
        // by `projects.setTarget`, the one writer of the placement columns.
        boxId: v.optional(v.id("boxes")),
        // The connected Cloudflare account a `cloudflare-workers` project deploys
        // into. Required for that target and absent otherwise — enforced by
        // `projects.setTarget`, the one writer of the placement columns.
        cloudflareAccountId: v.optional(v.id("cloudflareAccounts")),
        watchPaths: v.optional(v.array(v.string())),
    })
        .global()
        // A connected account's projects: disconnecting it reads them.
        .index("by_cloudflare_account", ["cloudflareAccountId"])
        // A box's projects: its routing table and every usage report it sends
        // read them, so neither may scan the whole table.
        .index("by_box", ["boxId"])
        .index("by_github_repo", ["githubRepo"])
        // Per-org slug uniqueness, enforced by the composite unique index.
        .index("by_org_slug", ["organizationId", "slug"], { unique: true }),

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

    auditLog: defineTable({
        action: v.string(),
        actorUserId: v.string(),
        createdAt: v.number(),
        organizationId: v.id("organizations"),
        target: v.optional(v.string()),
    })
        .global()
        .index("by_org", ["organizationId"]),

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
};
