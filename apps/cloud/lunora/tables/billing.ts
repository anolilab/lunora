/**
 * Billing and metering: the usage ledger, overage debits, BYO Cloudflare
 * billing, and the `@lunora/payment` tables.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

import { deployTarget, placementHost, usageMeter } from "./shared";

export const billingTables = {
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

    // Platform resource-metering events (§4), summed per org per billing period
    // for quota + overage billing. Written by the platform metering ingestion
    // endpoint (`POST /v1/usage`) and the Analytics-Engine stream. Distinct from
    // the `@lunora/payment` `usageEvents` ledger below (which meters *billing*
    // features); this one meters platform resources — every Cloudflare billing
    // dimension in `usageMeter`, not just compute, so a storage- or
    // DO-duration-shaped runaway is visible to the spend cap.
    platformUsage: defineTable({
        // `false` on a row that is displayed and NEVER billed (`src/billing/usage.ts`
        // `isBillableUsage` is the one test): counts a customer box reported
        // (plan 458 G15/D12 — the customer has root on the box, so they are not
        // billing evidence) and counts read back from a customer's own
        // Cloudflare account (`cloudflare-workers` — Cloudflare bills those to
        // the customer). Absent on every row the platform meters itself.
        billable: v.optional(v.boolean()),
        createdAt: v.number(),
        deploymentId: v.optional(v.id("deployments")),
        kind: usageMeter,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        // The host that reported (or was read for) this row — a box, or a
        // connected account — so the studio shows it per host and the roll-up
        // compacts it only with its own host's rows. Absent on platform-metered rows.
        placementRef: v.optional(placementHost),
        quantity: v.number(),
        // The report window a box row counts (epoch ms) — with `placementRef`,
        // the key that makes a replayed report a no-op instead of a double count.
        windowStart: v.optional(v.number()),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_placement_window", ["placementRef", "windowStart"]),

    // Metering readback checkpoints (§4), one per (target, scope): the epoch-ms
    // boundary a `metering: "readback"` target's source has been folded into
    // `platformUsage` through. The rollback reads `timestamp > readAtMs` and
    // advances it after, so repeated runs never double-count. A scope is one
    // independent source (`TargetFleet.usage.scopes()`): the cell's name for
    // `cloudflare-wfp`, a connected account's row id for `cloudflare-workers`.
    usageCheckpoints: defineTable({
        readAtMs: v.number(),
        scopeKey: v.string(),
        target: deployTarget,
        updatedAt: v.number(),
    })
        .global()
        .index("by_target_scope", ["target", "scopeKey"], { unique: true }),

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
        // Minor units as `v.number()`, not `v.bigint()`.
        //
        // `defineSchema` REFUSES a bigint on a `.global()` table, and refuses it
        // for a good reason: a global table stores one as decimal TEXT, which SQL
        // compares lexicographically — "100" sorts before "25" — so `orderBy`, a
        // range filter or an aggregate on the column silently returns wrong
        // answers. Every table in this schema is `.global()`, so this was not a
        // billing-only defect: the schema failed to construct and the control
        // plane could not boot at all.
        //
        // A double holds minor units exactly to 2^53 — about ninety trillion
        // dollars — so the precision a bigint was reaching for is not in question
        // at any amount this will ever see. The alternative the error message
        // offers, `v.string()`, buys equality only and would break the ordering
        // these columns are read with.
        amountMinor: v.number(),
        capturedMinor: v.number(),
        createdAt: v.number(),
        currency: v.string(),
        provider: v.string(),
        providerSessionId: v.string(),
        referenceId: v.string(),
        refundedMinor: v.number(),
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
};
