import { LunoraError } from "@lunora/server";

import { isDeployCapable } from "../src/deploy/capability";
import { formatDeployKey, hashDeployKey, parseDeployKey, randomSecret } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/** Public view of a deploy key — never exposes the stored hash. */
interface DeployKeyView {
    _id: Id<"deployKeys">;
    capability?: "deploy" | "ingest";
    createdAt: number;
    lastUsedAt?: number;
    name: string;
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
    revokedAt?: number;
    type: "dev" | "preview" | "production";
}

interface DeployKeyRow extends DeployKeyView {
    hashedKey: string;
}

/** List an organization's deploy keys (metadata only — the hash is never returned). */
export const list = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<DeployKeyView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });

        // Project to the public view — the stored hash is never returned.
        return page.map((row) => {
            return {
                _id: row._id,
                capability: row.capability,
                createdAt: row.createdAt,
                lastUsedAt: row.lastUsedAt,
                name: row.name,
                organizationId: row.organizationId,
                projectId: row.projectId,
                revokedAt: row.revokedAt,
                type: row.type,
            };
        });
    });

/**
 * Mint a deploy key (§2.2). The key encodes its target so the deploy API can
 * resolve org/project from the key alone, shaped
 * `type:organizationId[:projectId]|secret`. Only the SHA-256 hash is stored; the
 * plaintext is returned **once** and is never recoverable after. Owners/admins
 * only.
 */
export const issue = mutation
    .use(rateLimit("sensitive"))
    .input({
        // `ingest` mints a telemetry-only key (OTLP push, no deploy); omitted/`deploy` is a full deploy key.
        capability: v.optional(v.union(v.literal("deploy"), v.literal("ingest"))),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        projectId: v.optional(v.id("projects")),
        type: v.union(v.literal("production"), v.literal("dev"), v.literal("preview")),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<{ id: Id<"deployKeys">; key: string }> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        // A project-scoped key must name one of THIS org's projects. Without the
        // check the key is minted against a foreign project id — not an
        // escalation, since `authorizeDeployKey` compares the scope against the
        // target, but it produces a key that silently authorizes nothing and an
        // operator with no way to see why.
        if (arguments_.projectId !== undefined) {
            await assertRowInOrg(context, arguments_.projectId, arguments_.organizationId, "project");
        }

        const key = formatDeployKey({
            organizationId: arguments_.organizationId,
            ...(arguments_.projectId ? { projectId: arguments_.projectId } : {}), // secret-scanner:allow -- domain field name
            secret: randomSecret(),
            type: arguments_.type,
        });
        const hashedKey = await hashDeployKey(key);

        const id = await context.db.insert("deployKeys", {
            // Store the capability only for ingest keys, so existing/default deploy
            // rows stay byte-identical (absent = deploy).
            ...(arguments_.capability === "ingest" ? { capability: "ingest" as const } : {}),
            createdAt: context.now,
            hashedKey,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name
            type: arguments_.type,
        });

        return { id, key };
    });

/** Revoke a deploy key (owners/admins only). A revoked key fails `verify`. */
export const revoke = mutation
    .use(rateLimit("sensitive"))
    .input({ id: v.id("deployKeys"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "deploy key");

        await context.db.patch(id, { revokedAt: context.now });
    });

/** The subset of a key row that decides whether it can be rolled. */
interface RollCandidate {
    capability?: "deploy" | "ingest";
    revokedAt?: number;
}

/**
 * Why this key cannot be rolled, or `undefined` when it can.
 *
 * Split out of the mutation so the refusals are directly testable: the mutation
 * itself needs a member session and a live row, which makes the two conditions
 * that actually matter awkward to reach.
 */
export const rollRefusalReason = (existing: RollCandidate): string | undefined => {
    if (existing.revokedAt != null) {
        return "this key is already revoked — issue a new one instead of rolling it";
    }

    // Platform-managed ingest keys carry an envelope-encrypted copy of their
    // plaintext so the deploy path can re-inject the token into a tenant's
    // `otlpSink`. Minting a replacement here would leave that cipher pointing at
    // the revoked secret, and every later deploy would inject a dead token —
    // silently, because nothing reads telemetry back to notice. Rolling one needs
    // `recordIngestKey` in the same breath, which is a different (edge-side,
    // master-key-holding) call path.
    if (existing.capability === "ingest") {
        return "ingest keys are platform-managed and cannot be rolled from here";
    }

    return undefined;
};

/**
 * Roll a deploy key: mint a replacement and revoke the old one in a single
 * mutation (GAPS.md ring 3 #7). Owners/admins only.
 *
 * **Why this is one operation rather than two calls.** Rolling by hand is
 * `issue` then `revoke`, and between those two calls the org sits in one of two
 * bad states depending on the order: two live keys (the one you are retiring
 * still deploys) or none (CI is broken until someone pastes the new secret). A
 * Lunora mutation is transactional, so doing both here means neither window
 * exists — the key is replaced, or nothing happened.
 *
 * The replacement inherits name, type and project scope, so the only thing that
 * changes anywhere else is the secret value itself.
 *
 * **Ceiling worth knowing:** the old key stops working the moment this returns.
 * `verify` treats `revokedAt` as a presence flag rather than a deadline, so an
 * overlap window would require making that check time-based first. A deploy
 * already in flight on the old key can fail — roll between deploys.
 */
export const roll = mutation
    .use(rateLimit("sensitive"))
    .input({ id: v.id("deployKeys"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<{ id: Id<"deployKeys">; key: string }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "deploy key");

        const existing = (await context.db.get(id)) as DeployKeyRow | null;

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "deploy key not found");
        }

        const refusal = rollRefusalReason(existing);

        if (refusal !== undefined) {
            throw new LunoraError("BAD_REQUEST", refusal);
        }

        const key = formatDeployKey({
            organizationId,
            ...(existing.projectId ? { projectId: existing.projectId } : {}), // secret-scanner:allow -- domain field name
            secret: randomSecret(),
            type: existing.type,
        });
        const hashedKey = await hashDeployKey(key);

        const replacementId = await context.db.insert("deployKeys", {
            createdAt: context.now,
            hashedKey,
            name: existing.name,
            organizationId,
            projectId: existing.projectId, // secret-scanner:allow -- domain field name
            type: existing.type,
        });

        // Revoke AFTER the insert. If the insert fails — a hash collision violates
        // the unique `by_hash` index — the whole mutation rolls back and the caller
        // keeps a working key, rather than losing it to a half-applied roll.
        await context.db.patch(id, { revokedAt: context.now });

        return { id: replacementId, key };
    });

/**
 * Resolve a presented deploy key to its target, or `null` if invalid/revoked.
 * The match is by SHA-256 of the full key against the stored hash, so the
 * authoritative org/project come from the DB row, not the (untrusted) key text;
 * `parseDeployKey` is only a cheap pre-filter. On success, bumps `lastUsedAt`.
 *
 * Public `mutation` by necessity: the deploy endpoint calls it through the HTTP
 * action context's `ctx.runMutation`, whose dispatch carries no system-dispatch
 * flag, so an `internalMutation` would be unreachable there. Public exposure is
 * safe — lookup is by hash of a 256-bit key, so there is no enumeration oracle
 * (an attacker must already hold a valid key), and the only side effect is the
 * `lastUsedAt` bump on a genuine match.
 */
export const verify = mutation
    // `machine`, not `sensitive`: this is the per-request credential check for
    // `/v1/deploy` and `/v1/mcp`, so a human-scale 20/min bucket caps the whole
    // machine surface at ~20 deploys (or ~10 MCP calls) per minute per IP — and
    // inverts the two-tier design, since the router's outer per-IP bucket is
    // 120/min and is supposed to be the one that throttles first. Brute force is
    // not the risk it looks like: the key is a 256-bit secret matched by hash, and
    // an invalid or revoked one returns `null` rather than an oracle.
    .use(rateLimit("machine"))
    .input({ key: boundedString(LIMITS.token) })
    .mutation(
        async ({
            ctx: context,
            args: { key },
        }): Promise<null | {
            deployKeyId: Id<"deployKeys">;
            organizationId: Id<"organizations">;
            projectId?: Id<"projects">;
            type: "dev" | "preview" | "production";
        }> => {
            if (!parseDeployKey(key)) {
                return null;
            }

            const hashedKey = await hashDeployKey(key);
            const { page } = await context.db.deployKeys.findMany({ where: { hashedKey } });
            const row = page[0];

            // Reject a telemetry `ingest` key here too — this is the guard the deploy
            // route actually runs (`verifyKey`), so without it a scoped ingest token
            // would still be able to deploy. `authorizeDeployKey` blocks it on the
            // per-mutation paths; this blocks it at the deploy entrypoint (same
            // predicate, so they can't disagree).
            if (!row || row.revokedAt != null || !isDeployCapable(row)) {
                return null;
            }

            await context.db.patch(row._id, { lastUsedAt: context.now });

            return { deployKeyId: row._id, organizationId: row.organizationId, projectId: row.projectId, type: row.type };
        },
    );

/** The shape of an envelope-encrypted secret (mirrors `src/secrets/crypto` `EncryptedSecret`). */
interface CipherEnvelope {
    ciphertext: string;
    iv: string;
}

/** One row as the ingest-key helpers read it. */
interface IngestKeyRow {
    capability?: "deploy" | "ingest";
    encryptedSecret?: CipherEnvelope;
    revokedAt?: number;
}

/**
 * The org's live ingest key, if any — the single definition of "what counts as
 * the active ingest key" (an `ingest`-capability, non-revoked row that carries
 * its encrypted secret), so the reader and the writer can never drift apart.
 */
const findActiveIngestKey = (rows: IngestKeyRow[]): IngestKeyRow | undefined =>
    rows.find((candidate) => candidate.capability === "ingest" && candidate.revokedAt == null && candidate.encryptedSecret != null);

/**
 * The org's platform-managed ingest key ciphertext, for the deploy path to
 * re-inject into a tenant's `otlpSink`. Deploy-key authorized (the caller is a
 * live deploy holding the org's deploy key). Returns the envelope only — never
 * plaintext — or `null` when the org has no ingest key yet. The cipher is inert
 * without the master key, so exposing it to the deploy edge is safe.
 */
export const ingestKeyCipher = internalQuery
    .input({
        deployKey: boundedString(LIMITS.token),
        organizationId: v.id("organizations"),
    })
    .query(async ({ ctx: context, args: { deployKey, organizationId } }): Promise<CipherEnvelope | null> => {
        await authorizeDeployKey(context, organizationId, deployKey, "org-wide");

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });

        return findActiveIngestKey(page)?.encryptedSecret ?? null;
    });

/**
 * Record a platform-minted ingest key (its hash + envelope-encrypted plaintext),
 * returning the **effective** cipher — the freshly stored one, or a pre-existing
 * one if a concurrent deploy already provisioned it (so a race never injects a
 * token whose hash wasn't stored).
 *
 * SYSTEM only, and that is load-bearing. `hashedKey` and `encryptedSecret` are
 * inputs — the token itself is minted at the EDGE, because envelope encryption
 * needs the master key, which a mutation cannot reach. As a public mutation that
 * meant the credential was whatever the caller said it was: anyone holding any
 * live deploy key for the org (including a single-project CI key, since this
 * authorizes `"org-wide"`) could register an org-wide telemetry credential whose
 * plaintext they chose. It authenticates every ingest path for the whole org,
 * shows in the UI as "Telemetry ingest (auto)", and outlives revocation of the
 * key that created it. Only the deploy route mints these now.
 */
export const recordIngestKey = internalMutation
    .input({
        deployKey: boundedString(LIMITS.token),
        encryptedSecret: v.object({
            ciphertext: boundedString(LIMITS.secret),
            iv: boundedString(LIMITS.id),
        }),
        hashedKey: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { deployKey, encryptedSecret, hashedKey, organizationId } }): Promise<CipherEnvelope> => {
        await authorizeDeployKey(context, organizationId, deployKey, "org-wide");

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });
        const existing = findActiveIngestKey(page);

        if (existing?.encryptedSecret) {
            return existing.encryptedSecret; // a racing deploy already provisioned it
        }

        await context.db.insert("deployKeys", {
            capability: "ingest",
            createdAt: context.now,
            encryptedSecret,
            hashedKey,
            name: "Telemetry ingest (auto)",
            organizationId,
            type: "production",
        });

        return encryptedSecret;
    });
