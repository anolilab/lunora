import { CirrusError } from "@cirrus/server";

import { formatDeployKey, hashDeployKey, randomSecret } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

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

const assertSignedIn = (userId: null | string): void => {
    if (!userId) {
        throw new CirrusError("UNAUTHORIZED", "not signed in");
    }
};

/** List an organization's deploy keys (metadata only — the hash is never returned). */
export const list = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<DeployKeyView[]> => {
        assertSignedIn(context.auth.userId);

        const { page } = await context.db.deployKeys.findMany({ where: { organizationId } });

        // Project to the public view — the stored hash is never returned.
        return (page as unknown as (DeployKeyView & { hashedKey: string })[]).map((row) => {
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
 * plaintext is returned **once** and is never recoverable after.
 */
export const issue = mutation({
    args: {
        name: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.optional(v.id("projects")),
        type: v.union(v.literal("production"), v.literal("dev"), v.literal("preview")),
    },
    handler: async (context, arguments_): Promise<{ id: Id<"deployKeys">; key: string }> => {
        assertSignedIn(context.auth.userId);

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
