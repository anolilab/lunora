import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";

/**
 * GitHub App installations (GAPS.md A4), staged-claim model: the HMAC-verified
 * webhook {@link record}s an installation with **no org linkage** (so a spoofed
 * RPC call stages a harmless orphan row at worst), and an org owner/admin
 * {@link claim}s it from the dashboard. Push-to-deploy only trusts claimed
 * installations (`builds.recordPush` checks the pair).
 */

interface InstallationRow {
    _id: Id<"githubInstallations">;
    accountLogin: string;
    claimedAt?: number;
    createdAt: number;
    installationId: number;
    organizationId?: Id<"organizations">;
}

/**
 * Stage an installation (webhook `installation created`). Upserts by
 * installation id; deliberately records no org — claiming is a separate,
 * session-authorized step. `internal` — only the HMAC-verified webhook handler
 * invokes it (`context.runMutation`), never a public RPC client.
 */
export const record = internalMutation
    .input({ accountLogin: v.string(), installationId: v.number() })
    .mutation(async ({ ctx: context, args: { accountLogin, installationId } }): Promise<Id<"githubInstallations">> => {
        const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const existing = page[0];

        if (existing) {
            return existing._id;
        }

        return context.db.insert("githubInstallations", {
            accountLogin: accountLogin.toLowerCase(),
            createdAt: context.now,
            installationId,
        });
    });

/**
 * Claim a staged installation for the caller's org (owner/admin). The audit
 * trail records who linked what; an already-claimed installation cannot be
 * re-claimed by another org.
 */
export const claim = mutation
    .use(rateLimit("sensitive"))
    .input({ installationId: v.number(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { installationId, organizationId } }): Promise<void> => {
        const { userId } = await assertMember(context, organizationId, ["owner", "admin"]);

        const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const installation = page[0];

        if (!installation) {
            throw new LunoraError("NOT_FOUND", "installation not found — install the GitHub App first");
        }

        if (installation.organizationId != null && installation.organizationId !== organizationId) {
            throw new LunoraError("CONFLICT", "installation is already claimed by another organization");
        }

        await context.db.patch(installation._id, { claimedAt: context.now, organizationId });
        await context.db.insert("auditLog", {
            action: "github.installation.claim",
            actorUserId: userId,
            createdAt: context.now,
            organizationId,
            target: `${installation.accountLogin}#${String(installationId)}`,
        });
    });

/**
 * Release a claimed installation back to unclaimed (owner/admin).
 *
 * The inverse of {@link claim}, which had none: an installation claimed by the
 * wrong org — a plausible mistake, since claiming is a one-click action keyed on
 * an id the operator does not choose — could never be released from the
 * dashboard. The only removal was {@link remove}, driven by GitHub's own
 * `installation deleted` webhook, so the recovery was "uninstall the App from
 * GitHub entirely and reinstall it", which also detaches every other org
 * legitimately using it.
 *
 * The row is UNCLAIMED rather than deleted, so the staged installation is still
 * there for the right org to claim. Deleting it would require the App to be
 * reinstalled to re-stage, which is the same trap by a different route.
 *
 * Audited on both sides: `claim` records who linked it, and this records who let
 * it go.
 */
export const unclaim = mutation
    .use(rateLimit("sensitive"))
    .input({ installationId: v.number(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { installationId, organizationId } }): Promise<void> => {
        const { userId } = await assertMember(context, organizationId, ["owner", "admin"]);

        const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const installation = page[0];

        // Only the CLAIMING org may release it — otherwise this is a way to detach
        // another tenant's integration by guessing a numeric id.
        if (installation?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "installation not found in this organization");
        }

        await context.db.patch(installation._id, { claimedAt: null, organizationId: null });
        await context.db.insert("auditLog", {
            action: "github.installation.unclaim",
            actorUserId: userId,
            createdAt: context.now,
            organizationId,
            target: `${installation.accountLogin}#${String(installationId)}`,
        });
    });

/**
 * Remove an installation (webhook `installation deleted` — GitHub-driven).
 * `internal` — only the HMAC-verified webhook handler invokes it, so a public
 * RPC client can no longer unlink an arbitrary org's installation by id.
 */
export const remove = internalMutation.input({ installationId: v.number() }).mutation(async ({ ctx: context, args: { installationId } }): Promise<void> => {
    const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
    const existing = page[0];

    if (existing) {
        await context.db.delete(existing._id);
    }
});

/** An org's claimed GitHub installations (members). */
export const list = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<InstallationRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.githubInstallations.findMany({ where: { organizationId } });

        return page;
    });
