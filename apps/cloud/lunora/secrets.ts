import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";

/**
 * Tenant secrets (CLOUD-PLAN.md §7). Values are AES-256-GCM encrypted at the
 * Worker edge (`POST /v1/secrets` → `src/secrets/crypto.ts`) before they reach
 * `store`, so these functions only ever touch ciphertext — never plaintext.
 * `list` returns names only; `listEncrypted` (deploy path) returns ciphertext for
 * the edge to decrypt and inject into the tenant Worker at deploy time.
 */

interface SecretRow {
    _id: Id<"secrets">;
    ciphertext: string;
    createdAt: number;
    iv: string;
    name: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    updatedAt: number;
}

/** Persist an already-encrypted secret (owner/admin). Upserts by project+name. */
export const store = mutation({
    args: {
        ciphertext: v.string(),
        iv: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    },
    handler: async (context, arguments_): Promise<Id<"secrets">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        const { page } = await context.db.secrets.findMany({ where: { projectId: arguments_.projectId, name: arguments_.name } }); // secret-scanner:allow -- domain field name
        const existing = (page as unknown as SecretRow[])[0];
        const now = Date.now();

        if (existing) {
            await context.db.patch(existing._id, { ciphertext: arguments_.ciphertext, iv: arguments_.iv, updatedAt: now });

            return existing._id;
        }

        return context.db.insert("secrets", {
            ciphertext: arguments_.ciphertext,
            createdAt: now,
            iv: arguments_.iv,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name
            updatedAt: now,
        });
    },
});

/** A project's secret names (members) — never returns values. */
export const list = query({
    args: { organizationId: v.id("organizations"), projectId: v.id("projects") },
    handler: async (context, { organizationId, projectId }): Promise<{ createdAt: number; id: Id<"secrets">; name: string; updatedAt: number }[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.secrets.findMany({ where: { projectId } });

        return (page as unknown as SecretRow[]).map((secret) => {
            return { createdAt: secret.createdAt, id: secret._id, name: secret.name, updatedAt: secret.updatedAt };
        });
    },
});

/**
 * A project's encrypted secrets for the deploy path. Authorized by a member
 * session OR a valid `deployKey` (CI). Returns ciphertext + IV; the edge
 * decrypts and injects them into the tenant Worker — they never reach a browser.
 */
export const listEncrypted = query({
    args: { deployKey: v.optional(v.string()), organizationId: v.id("organizations"), projectId: v.id("projects") },
    handler: async (context, { deployKey, organizationId, projectId }): Promise<{ ciphertext: string; iv: string; name: string }[]> => {
        await (deployKey ? authorizeDeployKey(context, organizationId, deployKey, projectId) : assertMember(context, organizationId));

        const { page } = await context.db.secrets.findMany({ where: { projectId } });

        return (page as unknown as SecretRow[]).map((secret) => {
            return { ciphertext: secret.ciphertext, iv: secret.iv, name: secret.name };
        });
    },
});

/** Delete a secret (owner/admin). */
export const remove = mutation({
    args: { id: v.id("secrets"), organizationId: v.id("organizations") },
    handler: async (context, { id, organizationId }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "secret");

        await context.db.delete(id);
    },
});
