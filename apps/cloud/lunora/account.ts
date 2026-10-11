import { LunoraError } from "@lunora/server";

import { internalMutation, internalQuery, v } from "./_generated/server.js";
import { anonymiseScopedRows, purgeScopedRows } from "./purge";

/** Rows per list in one export. A caller with more than this gets the first page and a flag. */
const EXPORT_LIMIT = 1000;

/**
 * The version of the account export document. `/2` added `profile`, which the
 * router fills from the authentication layer; every `/1` key is unchanged.
 */
export const ACCOUNT_EXPORT_FORMAT = "lunora-account-export/2";

/**
 * The actor an audit entry names once its author has deleted their account.
 * One fixed value for every deleted user, so the entries of two deleted users
 * cannot be told apart or linked back to an account.
 */
export const DELETED_ACTOR = "deleted-user";

/**
 * The personal data the control plane holds about the signed-in caller, as a
 * machine-readable document (GDPR Art. 15 access and Art. 20 portability).
 *
 * It covers what the control plane itself stores under the caller's user id:
 * their memberships, and the audit entries they authored. The account profile
 * (email, name, sign-in methods) is held by the authentication layer, which a
 * Lunora function cannot reach, so `GET /v1/account/export` adds it as
 * `profile` and is the only caller. Lists are capped at {@link EXPORT_LIMIT};
 * `truncated` says when a list was cut off. It is a bounded read behind
 * sign-in, so it takes no write-side rate limit. SYSTEM only (router).
 */
export const exportMine = internalQuery.query(async ({ ctx: context }): Promise<Record<string, unknown>> => {
    const { userId } = context.auth;

    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const { page: memberships } = await context.db.members.findMany({ limit: EXPORT_LIMIT, where: { userId } });
    const { page: entries } = await context.db.auditLog.findMany({
        limit: EXPORT_LIMIT,
        orderBy: [{ createdAt: "asc" }],
        where: { actorUserId: userId },
    });

    return {
        auditEntries: entries.map((entry) => {
            return {
                action: entry.action,
                createdAt: entry.createdAt,
                organizationId: entry.organizationId,
                target: entry.target ?? null,
            };
        }),
        exportedAt: context.now,
        format: ACCOUNT_EXPORT_FORMAT,
        memberships: memberships.map((membership) => {
            return {
                createdAt: membership.createdAt,
                organizationId: membership.organizationId,
                role: membership.role,
            };
        }),
        truncated: memberships.length === EXPORT_LIMIT || entries.length === EXPORT_LIMIT,
    };
});

/** An organization that blocks an account deletion: the user is its only owner. */
export interface SoleOwnedOrganization {
    id: string;
    name: string;
}

/** The outcome of {@link eraseUser}. */
export type EraseUserResult = { erased: false; soleOwnerOf: SoleOwnedOrganization[] } | { erased: true };

/**
 * Remove what the control plane holds about a user whose account is being
 * deleted: their memberships go, and the audit entries they authored stay for
 * their retention period with the actor replaced by {@link DELETED_ACTOR}.
 *
 * Refused, with nothing written, while the user is the only owner of an
 * organization: the organization would be left with nobody able to manage or
 * delete it. An organization already scheduled for deletion does not block,
 * because the purge removes it anyway. Every check runs before the first write,
 * and the mutation is one transaction, so an owner leaving at the same moment
 * cannot slip between the check and the removal.
 *
 * Runs from the authentication layer's before-delete hook through
 * `POST /v1/account/erase`, after the password check and before the account
 * row is deleted. Idempotent: a second run finds nothing to change. SYSTEM only.
 */
export const eraseUser = internalMutation.input({ userId: v.string() }).mutation(async ({ ctx: context, args: { userId } }): Promise<EraseUserResult> => {
    const { page: memberships } = await context.db.members.findMany({ where: { userId } });
    const soleOwnerOf: SoleOwnedOrganization[] = [];

    for (const membership of memberships.filter((row) => row.role === "owner")) {
        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user owns few
        const organization = await context.db.organizations.get(membership.organizationId);

        if (organization === null || typeof organization.deletionRequestedAt === "number") {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user owns few
        const { page: owners } = await context.db.members.findMany({ where: { organizationId: membership.organizationId, role: "owner" } });

        if (owners.every((row) => row.userId === userId)) {
            soleOwnerOf.push({ id: organization._id, name: organization.name });
        }
    }

    if (soleOwnerOf.length > 0) {
        return { erased: false, soleOwnerOf };
    }

    await purgeScopedRows(context, ["members"], { userId });
    await anonymiseScopedRows(context, "auditLog", { actorUserId: userId }, () => {
        return { actorUserId: DELETED_ACTOR };
    });

    return { erased: true };
});
