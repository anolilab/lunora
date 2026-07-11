import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * GitHub App installations (GAPS.md A4): which org an App install belongs to.
 * Recorded/removed from the HMAC-verified webhook edge route (`installation`
 * events); the org linkage is claimed by slug match at install time and
 * confirmed by an org admin in the dashboard flow.
 */

interface InstallationRow {
    _id: Id<"githubInstallations">;
    accountLogin: string;
    createdAt: number;
    installationId: number;
    organizationId: Id<"organizations">;
}

interface OrganizationRow {
    _id: Id<"organizations">;
    slug: string;
}

/**
 * Record an installation, linking it to the org whose slug matches the GitHub
 * account login (Zeitwork's convention). Upserts by installation id; a
 * non-matching login is ignored (returns null) — nothing to link against.
 * Reached via the HMAC-verified webhook route.
 */
export const record = mutation
    .input({ accountLogin: v.string(), installationId: v.number() })
    .mutation(async ({ ctx: context, args: { accountLogin, installationId } }): Promise<null | Id<"githubInstallations">> => {
        const login = accountLogin.toLowerCase();
        const { page: organizationPage } = await context.db.organizations.findMany({ where: { slug: login } });
        const organization = (organizationPage as unknown as OrganizationRow[])[0];

        if (!organization) {
            return null;
        }

        const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const existing = (page as unknown as InstallationRow[])[0];

        if (existing) {
            return existing._id;
        }

        return context.db.insert("githubInstallations", {
            accountLogin: login,
            createdAt: Date.now(),
            installationId,
            organizationId: organization._id,
        });
    });

/** Remove an installation (the App was uninstalled). Reached via the webhook route. */
export const remove = mutation.input({ installationId: v.number() }).mutation(async ({ ctx: context, args: { installationId } }): Promise<void> => {
    const { page } = await context.db.githubInstallations.findMany({ where: { installationId } });
    const existing = (page as unknown as InstallationRow[])[0];

    if (existing) {
        await context.db.delete(existing._id);
    }
});

/** An org's GitHub installations (members). */
export const list = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<InstallationRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.githubInstallations.findMany({ where: { organizationId } });

        return page;
    });
