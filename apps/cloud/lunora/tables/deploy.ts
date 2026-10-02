/**
 * Deploying a project: releases and their aliases, deploy keys, git builds
 * and their logs, custom domains, tenant secrets and tenant backups.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

import { deployTarget } from "./shared";

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

export const deployTables = {
    deployments: defineTable({
        // Tenant admin bearer the platform set on the deployed worker; lets the
        // hosted-studio admin proxy (§3) call its /_lunora/admin/*. Sealed at rest
        // with SECRET_ENCRYPTION_KEY (§7): ciphertext + IV below. `adminToken`
        // (plaintext) is the dev-only fallback written when no master key is set.
        adminToken: v.optional(v.string()),
        adminTokenCiphertext: v.optional(v.string()),
        adminTokenIv: v.optional(v.string()),
        // The project's stable label — its public subdomain and the name of its
        // one dispatch-namespace script, which every release updates in place.
        alias: v.optional(v.string()),
        // The box a `celld-vps` release was converged on, copied from the
        // project's placement when the row is created. Teardown reads it here,
        // not through the project: deleting a project removes the row that
        // would have named the box, while its fleet and data still run on it.
        boxId: v.optional(v.id("boxes")),
        // The connected Cloudflare account a `cloudflare-workers` release was
        // converged into, copied from the project like `boxId`: teardown and
        // usage readback reach the account through it after the project is gone.
        cloudflareAccountId: v.optional(v.id("cloudflareAccounts")),
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
        // Content hash of the uploaded worker bundle. The bundle itself is stored
        // in the `RELEASES` R2 bucket under this row's id — a rollback
        // re-provisions it onto the alias's Worker (§2.2).
        bundleHash: v.optional(v.string()),
        createdAt: v.number(),
        createdBy: v.string(),
        // Preview deployments expire (TTL); the cleanup cron tears them down (§2.3).
        expiresAt: v.optional(v.number()),
        kind: deploymentKind,
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        // The deployment's handle on its target — what the driver addresses it
        // by (the dispatch script on `cloudflare-wfp`). Absent on rows that
        // predate it, where `scriptName` serves.
        resourceRef: v.optional(v.string()),
        // `cloudflare-wfp` encoding: the dispatch-namespace script this
        // deployment was provisioned onto — the alias. One script per alias,
        // not per release: a Durable Object namespace belongs to the script
        // defining its class, so a script per release would start every release
        // on an empty database (GAPS.md A1).
        scriptName: v.string(),
        status: deploymentStatus,
        // The target this release was converged on, copied from the project when
        // the row is created — so a later change of the project's target never
        // sends a teardown or a rollback to the wrong driver. Absent on rows
        // that predate it, which are `cloudflare-wfp`.
        target: v.optional(deployTarget),
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
        // Set when the teardown sweep has reclaimed this row's stored release —
        // and, for the alias's last deployment, its Worker and project resources
        // (GAPS.md A1 / §2.3). The sweep only acts on `destroyed`/`failed` rows
        // where this is unset, so it is crash-safe idempotent.
        teardownAt: v.optional(v.number()),
    })
        .global()
        // A connected account's deployments: disconnecting it reads them.
        .index("by_cloudflare_account", ["cloudflareAccountId"])
        .index("by_kind", ["kind"])
        // Every read that scopes deployments to an ORG went unindexed: the Traffic
        // tab, the onboarding checklist and the org purge all filtered on
        // `organizationId` with nothing to serve it, so each scanned every
        // deployment on the platform. Composite with `createdAt` because the
        // checklist also orders by it — an ordered read over an unindexed filter
        // sorts every match to return a handful, and that cost grows with the
        // whole fleet rather than with the org asking.
        .index("by_org_created", ["organizationId", "createdAt"])
        .index("by_project", ["projectId"])
        // Dispatcher resolves a request's script id → org plan via this index.
        .index("by_script", ["scriptName"])
        // `pruneSuperseded` reads the superseded rows directly rather than paging
        // the whole table and filtering after — see its note on page starvation.
        .index("by_status", ["status"]),

    // One-row-per-alias ownership ledger. An alias (the tenant's stable script
    // label and script name) seeds per-project D1/R2 resource names and names the
    // project's Worker, so it MUST belong to exactly one project.
    // `deployments.alias` repeats across a project's releases, so it can't carry
    // a unique index itself; this
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
        // A hard deadline, after which the key authorizes nothing — set only on
        // platform-minted git-build release keys, so a release whose Worker dies
        // before `removeReleaseKey` runs cannot leave a live key behind.
        expiresAt: v.optional(v.number()),
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
        // A pull request whose head is a fork's. Built, never released: a
        // preview release resolves the project's secrets and mints its ingest
        // key, which opening a pull request must never reach.
        fromFork: v.optional(v.boolean()),
        organizationId: v.id("organizations"),
        // Work lease: which runner is on it and since when (stale after 30 min).
        processingBy: v.optional(v.string()),
        processingStartedAt: v.optional(v.number()),
        projectId: v.id("projects"),
        // The pull request number, for `pull_request` builds.
        pullRequest: v.optional(v.number()),
        // An earlier successful build of the same commit, root directory and
        // trigger whose release is no longer serving: this build re-releases
        // that build's stored release (`releases/<deploymentId>.json`) instead
        // of rebuilding, or rebuilds once the release was pruned.
        reusesBuildId: v.optional(v.id("builds")),
        // The project's rootDirectory when the push was recorded, so a settings
        // change mid-queue cannot build a commit from a directory it was not
        // pushed for, and dedup never reuses a bundle built from another root.
        rootDirectory: v.optional(v.string()),
        // Why a push was not built — set only on `skipped` rows (path filter).
        skipReason: v.optional(v.string()),
        status: v.union(v.literal("pending"), v.literal("building"), v.literal("successful"), v.literal("failed"), v.literal("skipped")),
        // What recorded the build, which decides how it releases: a push to the
        // default branch goes to production, a pull request to a preview. Absent
        // on rows recorded before releases existed — those release as previews,
        // the kind that can never move a project's stable URL.
        trigger: v.optional(v.union(v.literal("push"), v.literal("pull_request"))),
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

    // Tenant data backups (docs/RESTORE.md): one row per snapshot of a project's
    // production data taken into the private `TENANT_BACKUPS` bucket, and one per
    // restore of such a snapshot. Written by the studio's backup/restore routes
    // (through `lunora/tenant-backups.ts`) and by the scheduled sweep
    // (`src/backup/tenant-sweep.ts`), which also enforces per-plan retention and
    // deletes a deleted project's snapshots — so this table is deliberately NOT
    // in the org purge's list: the rows are what lets the sweep find the objects.
    tenantBackups: defineTable({
        alias: v.string(),
        // Compressed size of the stored snapshot.
        bytes: v.optional(v.number()),
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        // The deployment whose Worker the snapshot was read from / restored into.
        deploymentId: v.id("deployments"),
        // Bounded failure reason: the tenant's status + error message, never data.
        error: v.optional(v.string()),
        // R2 key of the snapshot (backup rows); the source snapshot's key (restore rows).
        key: v.string(),
        operation: v.union(v.literal("backup"), v.literal("restore")),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        // Restore rows: the snapshot restored, and what the append-only import did.
        restoredFrom: v.optional(v.id("tenantBackups")),
        restoreConflicts: v.optional(v.number()),
        restoreInserted: v.optional(v.number()),
        restoreRowErrors: v.optional(v.number()),
        status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed")),
        trigger: v.union(v.literal("scheduled"), v.literal("manual"), v.literal("pre-restore")),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_project", ["projectId"]),
};
