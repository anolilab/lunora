import { defineSchema, defineTable, v } from "@cirrus/server";

/**
 * Cirrus Cloud control-plane data model — see `CLOUD-PLAN.md` (§2.2 control
 * plane, §2.5 cells). This is the *platform's* own schema, dogfooded on Cirrus
 * itself (the platform's metadata store is a Cirrus app).
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
    v.literal("live"),
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
        // hosted-studio admin proxy (§3) call its /_cirrus/admin/*. Should be
        // envelope-encrypted at rest (§7) — stored plain here for the scaffold.
        adminToken: v.optional(v.string()),
        // Preview deployments carry the originating git branch (§2.3).
        branch: v.optional(v.string()),
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
        // Dispatch-namespace script id this deployment provisioned.
        scriptName: v.string(),
        status: deploymentStatus,
        updatedAt: v.number(),
        url: v.optional(v.string()),
    })
        .global()
        .index("by_kind", ["kind"])
        .index("by_project", ["projectId"]),

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

    // Metered usage events (§4), summed per org per billing period for quota +
    // overage billing. Written by the platform from the Analytics-Engine stream.
    usageEvents: defineTable({
        createdAt: v.number(),
        deploymentId: v.optional(v.id("deployments")),
        kind: v.union(v.literal("requests"), v.literal("cpuMs"), v.literal("storageBytes")),
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"]),
});
