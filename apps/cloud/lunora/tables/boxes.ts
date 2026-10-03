/**
 * Customer infrastructure the control plane deploys onto: boxes (plan 458) —
 * enrolled machines, their one-time enrolment tokens and signed `lunora-hostd`
 * releases — and connected Cloudflare accounts (the `cloudflare-workers` target).
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

/**
 * A customer box's lifecycle (plan 458 G12): `pending` from enrolment until its
 * `hostd` first authenticates, then `online` / `offline` as its session comes
 * and goes, and `revoked` for good — a revoked box never comes back; the machine
 * enrols again as a new box (§3 rule 6).
 */
const boxStatus = v.union(v.literal("pending"), v.literal("online"), v.literal("offline"), v.literal("revoked"));

/** The three binaries on a box, as its `hostd` reports them (`@lunora/hostd/protocol` `BoxVersions`). Displayed, never parsed. */
const boxVersions = v.object({ caddy: v.string(), celld: v.string(), hostd: v.string() });

/** One celld fleet on a box, as its `hostd` reports it (`@lunora/hostd/protocol` `FleetSummary`). */
const boxFleet = v.object({
    alias: v.string(),
    deploymentId: v.optional(v.string()),
    state: v.union(v.literal("running"), v.literal("stopped"), v.literal("starting"), v.literal("failed")),
});

export const boxesTables = {
    // A machine a customer runs `lunora-hostd` on (plan 458 D13, G12): org-owned,
    // never shared, and its `organizationId` never changes (§3 rule 6). The
    // control plane holds the box's PUBLIC key and nothing else from it (§3 rule
    // 5) — every session and every signed request is checked against it.
    boxes: defineTable({
        // Set with `desiredReleaseId` by a rollback (`POST /v1/hostd/rollout`
        // with `allowDowngrade`, audited): the `upgrade` jobs that carry the box
        // to that release may install an OLDER `lunora-hostd`, which a box
        // otherwise refuses (protocol §5.2). Any other rollout sets it false.
        allowDowngrade: v.optional(v.boolean()),
        createdAt: v.number(),
        // The `hostdReleases.releaseId` this box should run (plan 458 W7); an
        // `upgrade` job moves it there. Absent → whatever it runs is fine.
        desiredReleaseId: v.optional(v.string()),
        // Why the box's DNS records could not be created (or removed), when they
        // could not — surfaced on the row rather than failing the enrolment.
        dnsError: v.optional(v.string()),
        enrolledAt: v.optional(v.number()),
        // The celld fleets the box runs (one per alias, at most 500): what its
        // `hello` reported, moved on by each deploy / reload / destroy the
        // session sees succeed (`src/boxes/fleets.ts`). Displayed, never trusted.
        fleets: v.optional(v.array(boxFleet)),
        ipv4: v.optional(v.string()),
        ipv6: v.optional(v.string()),
        lastSeenAt: v.optional(v.number()),
        name: v.string(),
        organizationId: v.id("organizations"),
        // The box's Ed25519 public key: the RAW 32 bytes, base64url without
        // padding (43 characters) — the form WebCrypto imports as "raw".
        publicKey: v.string(),
        resources: v.optional(v.object({ diskFreeMb: v.number(), memMb: v.number() })),
        revokedAt: v.optional(v.number()),
        // `hostd enrol --single-trust`: the box skips the tenant isolation
        // self-check (plan 458 W8). Recorded so the studio can say so.
        singleTrust: v.boolean(),
        // The box's DNS label (`<alias>.<slug>.<LUNORA_BOX_DOMAIN>`). Random,
        // so a public hostname never leaks the name the customer chose.
        slug: v.string(),
        status: boxStatus,
        versions: v.optional(boxVersions),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_slug", ["slug"], { unique: true }),

    // One-time enrolment tokens (plan 458 D4): valid 15 minutes, single use,
    // stored hashed. Consuming one binds a box's public key to the org.
    boxEnrolments: defineTable({
        // The box the token enrolled, once used — what lets a retried enrolment
        // with the same key answer the same box instead of failing.
        boxId: v.optional(v.id("boxes")),
        createdAt: v.number(),
        createdBy: v.string(),
        expiresAt: v.number(),
        // SHA-256 of the token; the plaintext is shown once and never stored.
        hashedToken: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        usedAt: v.optional(v.number()),
    })
        .global()
        .index("by_hash", ["hashedToken"], { unique: true })
        .index("by_org", ["organizationId"]),

    // Signed `lunora-hostd` releases the control plane offers boxes (plan 458
    // W7, G17). Stored only after the envelope verified against the pinned
    // release keys; boxes fetch the envelope verbatim and verify it themselves.
    hostdReleases: defineTable({
        // `canary` releases go to boxes named in a rollout; `stable` is what an
        // outdated box is measured against. Absent → stable.
        channel: v.optional(v.union(v.literal("stable"), v.literal("canary"))),
        createdAt: v.number(),
        // The signed envelope (`manifest.json`), as JSON — served to boxes as is.
        envelope: v.string(),
        keyId: v.string(),
        releaseId: v.string(),
        // What the release installs, lifted out of the envelope so a box's
        // reported versions can be compared to it without parsing.
        versions: boxVersions,
    })
        .global()
        .index("by_release", ["releaseId"], { unique: true }),

    // A Cloudflare account an organization connected for the `cloudflare-workers`
    // target (MULTIPLATFORM.md Phase 3): its projects deploy as plain Workers
    // into it. The scoped API token is AES-256-GCM encrypted at the edge
    // (`POST /v1/cloudflare-accounts` → `src/secrets/crypto.ts`) after it was
    // verified against the account, so only ciphertext + IV live here — never
    // the token. Disconnecting deletes the row (and with it the credential);
    // `cloudflareAccounts.disconnect` refuses while a project or an un-torn-down
    // deployment still names it.
    cloudflareAccounts: defineTable({
        // The Cloudflare account id (32 hex) — the account's own, not this row's.
        accountId: v.string(),
        // The cell of the organization that connected it, copied at connect time
        // (`organizations.cellId` never changes): the cell's control plane
        // converges and meters it, and reads its accounts in one query (`by_cell`).
        cellId: v.id("cells"),
        ciphertext: v.string(),
        createdAt: v.number(),
        createdBy: v.string(),
        // The account's display name, when the token may read it (Account Settings Read is optional).
        displayName: v.optional(v.string()),
        iv: v.string(),
        // The organization's own name for the connection.
        label: v.string(),
        organizationId: v.id("organizations"),
        // The permission groups the token was seen to hold when last verified
        // (`CLOUDFLARE_TOKEN_PERMISSIONS` in `src/provision-contract.ts`).
        permissions: v.array(v.string()),
        // When the token stops working, if it was created with an expiry.
        tokenExpiresAt: v.optional(v.number()),
        updatedAt: v.number(),
        verifiedAt: v.number(),
        // The account's `workers.dev` subdomain: tenants answer at `<alias>.<subdomain>.workers.dev`.
        workersSubdomain: v.string(),
    })
        .global()
        .index("by_cell", ["cellId"])
        .index("by_org", ["organizationId"])
        // One connection per account per organization: a second token for the same account is a rotation.
        .index("by_org_account", ["organizationId", "accountId"], { unique: true }),
};
