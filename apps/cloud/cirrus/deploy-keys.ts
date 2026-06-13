import { formatDeployKey, hashDeployKey, parseDeployKey, randomSecret } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/** Public view of a deploy key — never exposes the stored hash. */
interface DeployKeyView {
    _id: Id<"deployKeys">;
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
export const list = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<DeployKeyView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });

        // Project to the public view — the stored hash is never returned.
        return (page as unknown as DeployKeyRow[]).map((row) => {
            return {
                _id: row._id,
                createdAt: row.createdAt,
                lastUsedAt: row.lastUsedAt,
                name: row.name,
                organizationId: row.organizationId,
                projectId: row.projectId,
                revokedAt: row.revokedAt,
                type: row.type,
            };
        });
    },
});

/**
 * Mint a deploy key (§2.2). The key encodes its target so the deploy API can
 * resolve org/project from the key alone, shaped
 * `type:organizationId[:projectId]|secret`. Only the SHA-256 hash is stored; the
 * plaintext is returned **once** and is never recoverable after. Owners/admins
 * only.
 */
export const issue = mutation({
    args: {
        name: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.optional(v.id("projects")),
        type: v.union(v.literal("production"), v.literal("dev"), v.literal("preview")),
    },
    handler: async (context, arguments_): Promise<{ id: Id<"deployKeys">; key: string }> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        const key = formatDeployKey({
            organizationId: arguments_.organizationId,
            ...(arguments_.projectId ? { projectId: arguments_.projectId } : {}),
            secret: randomSecret(),
            type: arguments_.type,
        });
        const hashedKey = await hashDeployKey(key);

        const id = await context.db.insert("deployKeys", {
            createdAt: Date.now(),
            hashedKey,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId,
            type: arguments_.type,
        });

        return { id, key };
    },
});

/** Revoke a deploy key (owners/admins only). A revoked key fails `verify`. */
export const revoke = mutation({
    args: { id: v.id("deployKeys"), organizationId: v.id("organizations") },
    handler: async (context, { id, organizationId }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        await context.db.patch(id, { revokedAt: Date.now() });
    },
});

/**
 * Resolve a presented deploy key to its target, or `null` if invalid/revoked.
 * The match is by SHA-256 of the full key against the stored hash, so the
 * authoritative org/project come from the DB row, not the (untrusted) key text;
 * `parseDeployKey` is only a cheap pre-filter. On success, bumps `lastUsedAt`.
 *
 * SYSTEM mutation: this is the deploy API's authentication path, NOT a
 * user-facing call. It must be invoked server-side behind the deploy endpoint
 * (an `internalMutation` once that wiring exists), never exposed to clients.
 */
export const verify = mutation({
    args: { key: v.string() },
    handler: async (
        context,
        { key },
    ): Promise<null | {
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

        if (!row || row.revokedAt !== undefined) {
            return null;
        }

        await context.db.patch(row._id, { lastUsedAt: Date.now() });

        return { deployKeyId: row._id, organizationId: row.organizationId, projectId: row.projectId, type: row.type };
    },
});
