import { isDeployCapable } from "../src/deploy/capability";
import { formatDeployKey, hashDeployKey, parseDeployKey, randomSecret } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
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
        return (page as unknown as DeployKeyRow[]).map((row) => {
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
            const row = (page as unknown as DeployKeyRow[])[0];

            // Reject a telemetry `ingest` key here too — this is the guard the deploy
            // route actually runs (`verifyKey`), so without it a scoped ingest token
            // would still be able to deploy. `authorizeDeployKey` blocks it on the
            // per-mutation paths; this blocks it at the deploy entrypoint (same
            // predicate, so they can't disagree).
            if (!row || row.revokedAt !== undefined || !isDeployCapable(row)) {
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
    rows.find((candidate) => candidate.capability === "ingest" && candidate.revokedAt === undefined && candidate.encryptedSecret !== undefined);

/**
 * The org's platform-managed ingest key ciphertext, for the deploy path to
 * re-inject into a tenant's `otlpSink`. Deploy-key authorized (the caller is a
 * live deploy holding the org's deploy key). Returns the envelope only — never
 * plaintext — or `null` when the org has no ingest key yet. The cipher is inert
 * without the master key, so exposing it to the deploy edge is safe.
 */
export const ingestKeyCipher = query
    .input({
        deployKey: boundedString(LIMITS.token),
        organizationId: v.id("organizations"),
    })
    .query(async ({ ctx: context, args: { deployKey, organizationId } }): Promise<CipherEnvelope | null> => {
        await authorizeDeployKey(context, organizationId, deployKey);

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });

        return findActiveIngestKey(page)?.encryptedSecret ?? null;
    });

/**
 * Record a platform-minted ingest key (its hash + envelope-encrypted plaintext),
 * returning the **effective** cipher — the freshly stored one, or a pre-existing
 * one if a concurrent deploy already provisioned it (so a race never injects a
 * token whose hash wasn't stored). Deploy-key authorized.
 */
export const recordIngestKey = mutation
    .use(rateLimit("sensitive"))
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
        await authorizeDeployKey(context, organizationId, deployKey);

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
