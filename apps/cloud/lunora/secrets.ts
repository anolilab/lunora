import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

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
    environment: "all" | "dev" | "preview" | "production";
    iv: string;
    name: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    updatedAt: number;
}

/** Persist an already-encrypted secret (owner/admin). Upserts by project+name. */
export const store = mutation
    .use(rateLimit("api"))
    .input({
        ciphertext: boundedString(LIMITS.secret),
        // Deployment kind this secret applies to; defaults to "all" (shared).
        environment: v.optional(v.union(v.literal("all"), v.literal("production"), v.literal("preview"), v.literal("dev"))),
        iv: boundedString(LIMITS.id),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"secrets">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, arguments_.projectId, arguments_.organizationId, "project");

        const environment = arguments_.environment ?? "all";
        const { page } = await context.db.secrets.findMany({
            where: { environment, name: arguments_.name, organizationId: arguments_.organizationId, projectId: arguments_.projectId }, // secret-scanner:allow -- domain field name
        });
        const existing = page[0];
        const { now } = context;

        if (existing) {
            await context.db.patch(existing._id, { ciphertext: arguments_.ciphertext, iv: arguments_.iv, updatedAt: now });

            return existing._id;
        }

        return context.db.insert("secrets", {
            ciphertext: arguments_.ciphertext,
            createdAt: now,
            environment,
            iv: arguments_.iv,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name
            updatedAt: now,
        });
    });

/** A project's secret names (members) — never returns values. */
export const list = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(
        async ({
            ctx: context,
            args: { organizationId, projectId },
        }): Promise<{ createdAt: number; environment: string; id: Id<"secrets">; name: string; updatedAt: number }[]> => {
            await assertMember(context, organizationId);
            await assertRowInOrg(context, projectId, organizationId, "project");

            const { page } = await context.db.secrets.findMany({ where: { organizationId, projectId } });

            return page.map((secret) => {
                return { createdAt: secret.createdAt, environment: secret.environment, id: secret._id, name: secret.name, updatedAt: secret.updatedAt };
            });
        },
    );

/**
 * A project's encrypted secrets for the deploy path. Authorized by a member
 * session OR a valid `deployKey` (CI). Returns ciphertext + IV; the edge
 * decrypts and injects them into the tenant Worker — they never reach a browser.
 */
export const listEncrypted = query
    .input({
        deployKey: v.optional(boundedString(LIMITS.token)),
        // Deployment kind being provisioned; kind-specific secrets override
        // same-named "all" (shared) rows. Defaults to production.
        environment: v.optional(v.union(v.literal("production"), v.literal("preview"), v.literal("dev"))),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    })
    .query(
        async ({ ctx: context, args: { deployKey, environment, organizationId, projectId } }): Promise<{ ciphertext: string; iv: string; name: string }[]> => {
            await (deployKey ? authorizeDeployKey(context, organizationId, deployKey, projectId) : assertMember(context, organizationId));
            await assertRowInOrg(context, projectId, organizationId, "project");

            const kind = environment ?? "production";
            const { page } = await context.db.secrets.findMany({ where: { organizationId, projectId } });
            const rows = page.filter((secret) => secret.environment === kind || secret.environment === "all");

            // Kind-specific rows override shared ("all") rows of the same name.
            const byName = new Map<string, SecretRow>();

            for (const secret of rows) {
                const existing = byName.get(secret.name);

                if (!existing || (existing.environment === "all" && secret.environment !== "all")) {
                    byName.set(secret.name, secret);
                }
            }

            return [...byName.values()].map((secret) => {
                return { ciphertext: secret.ciphertext, iv: secret.iv, name: secret.name };
            });
        },
    );

/** Delete a secret (owner/admin). */
export const remove = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("secrets"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "secret");

        await context.db.delete(id);
    });
