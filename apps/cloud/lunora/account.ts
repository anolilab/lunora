import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation, internalQuery, v } from "./_generated/server.js";
import { legacySetRoleTargetRole } from "./members";
import { collectAll } from "./paginate";
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

/** An organization the user is the only owner of: it blocks a self-service deletion. */
export interface SoleOwnedOrganization {
    id: string;
    name: string;
}

/**
 * The outcome of {@link eraseUser}. `retainedOwnerOf`, present only for an
 * operator removal, lists the organizations whose owner membership the erasure
 * kept because the user was their only owner; self-service refuses instead.
 */
export type EraseUserResult = { erased: false; soleOwnerOf: SoleOwnedOrganization[] } | { erased: true; retainedOwnerOf?: SoleOwnedOrganization[] };

/** The actor of the audit entry that marks an organization whose removed owner's membership was kept. */
export const ERASURE_ACTOR = "system:account-erasure";

/** The action of that entry; support looks for it to transfer the ownership. */
export const OWNER_REMOVED_ACTION = "organization.owner-removed";

/**
 * The `target` of that entry: the kept membership's row id (which names no
 * person) and what support has to do. One entry per kept membership, so a
 * repeated removal does not add another.
 */
const ownerRemovedTarget = (memberId: string): string =>
    `${memberId}: the only owner's account was removed by an operator; the membership is kept until support transfers ownership`;

/** The live organizations `userId` is the only owner of, among their `memberships`. */
const soleOwnedOrganizations = async (
    context: MutationContext,
    userId: string,
    memberships: ReadonlyArray<{ organizationId: Id<"organizations">; role: string }>,
): Promise<SoleOwnedOrganization[]> => {
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

    return soleOwnerOf;
};

/**
 * Replace `userId` in old-format `member.set-role` targets (`{user id} → {role}`)
 * with {@link DELETED_ACTOR}, in `organizationIds`. Read per organization through
 * the `by_org` index: the table has no index on `action`. An entry in an
 * organization the user had already left is out of reach and keeps the old id
 * until the retention sweep deletes it.
 */
const rewriteLegacySetRoleTargets = async (context: MutationContext, userId: string, organizationIds: ReadonlySet<Id<"organizations">>): Promise<void> => {
    for (const organizationId of organizationIds) {
        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user is in few
        const entries = await collectAll<{ _id: Id<"auditLog">; target?: string }>((cursor) =>
            context.db.auditLog.findMany({ cursor, where: { action: "member.set-role", organizationId } }),
        );

        for (const entry of entries) {
            const role = legacySetRoleTargetRole(entry.target, userId);

            if (role !== undefined) {
                // eslint-disable-next-line no-await-in-loop -- sequential patches; few entries per organization
                await context.db.patch(entry._id, { target: `${DELETED_ACTOR} → ${role}` });
            }
        }
    }
};

/**
 * The operator path's membership erasure when the user is the only owner of
 * `retainedOrganizationIds`: delete every other membership, keep those, and
 * mark each kept one with an {@link OWNER_REMOVED_ACTION} entry unless an
 * earlier run already did.
 */
const keepSoleOwnerships = async (
    context: MutationContext,
    memberships: ReadonlyArray<{ _id: Id<"members">; organizationId: Id<"organizations"> }>,
    retainedOrganizationIds: ReadonlySet<string>,
): Promise<void> => {
    for (const membership of memberships) {
        if (!retainedOrganizationIds.has(membership.organizationId)) {
            // eslint-disable-next-line no-await-in-loop -- sequential deletes; a user is in few organizations
            await context.db.delete(membership._id);
            continue;
        }

        const target = ownerRemovedTarget(membership._id);
        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user owns few
        const { page: marks } = await context.db.auditLog.findMany({
            limit: 1,
            where: { action: OWNER_REMOVED_ACTION, organizationId: membership.organizationId, target },
        });

        if (marks.length === 0) {
            // eslint-disable-next-line no-await-in-loop -- one entry per organization; a user owns few
            await context.db.insert("auditLog", {
                action: OWNER_REMOVED_ACTION,
                actorUserId: ERASURE_ACTOR,
                createdAt: context.now,
                organizationId: membership.organizationId,
                target,
            });
        }
    }
};

/**
 * Remove what the control plane holds about a user whose account is being
 * deleted: their memberships go, and the audit entries they authored stay for
 * their retention period with the actor replaced by {@link DELETED_ACTOR}.
 * `member.set-role` entries in the old format, which name the member by user id
 * (see `setRoleAuditTarget` in `members.ts`), are rewritten to name
 * {@link DELETED_ACTOR} instead, in every organization the user was still a
 * member of.
 *
 * Self-service (`operator` unset): refused, with nothing written, while the user
 * is the only owner of an organization, because the organization would be left
 * with nobody able to manage or delete it. The user can transfer ownership
 * first.
 *
 * Operator removal (`operator: true`, from the auth admin's `removeUser`): never
 * refused. The operator acts on the account (abuse, a legal request, a user who
 * cannot sign in any more), and the user cannot be asked to transfer ownership
 * first. An organization must not be left without an owner, and handing it to
 * another member would give it to someone who never accepted it, so a sole
 * owner's membership is kept and the organization is left unchanged. It gets an
 * {@link OWNER_REMOVED_ACTION} audit entry by {@link ERASURE_ACTOR}, the mark
 * support works from (its admins see it in the Activity tab), and is listed in
 * the result as `retainedOwnerOf`. Every other membership goes, and the audit
 * actor is anonymised as for self-service. The kept row is the one place the
 * user's id stays: until support transfers the ownership, or the organization is
 * deleted, which purges it.
 *
 * An organization already scheduled for deletion counts for neither path,
 * because the purge removes it anyway. Every check runs before the first write,
 * so a refusal changes nothing. The tables are `.global()` (D1, which has no
 * interactive transaction), so the check and the writes are not isolated from
 * another owner leaving at the same moment.
 *
 * Runs through `POST /v1/account/erase`: from the authentication layer's
 * before-delete hook, after the password check and before the account row is
 * deleted, and from the operator's `removeUser` before the auth cascade.
 * Idempotent: a second run changes nothing, and finds the kept memberships
 * already marked. SYSTEM only.
 */
export const eraseUser = internalMutation
    .input({ operator: v.optional(v.boolean()), userId: v.string() })
    .mutation(async ({ ctx: context, args: { operator, userId } }): Promise<EraseUserResult> => {
        const { page: memberships } = await context.db.members.findMany({ where: { userId } });
        const soleOwnerOf = await soleOwnedOrganizations(context, userId, memberships);

        if (soleOwnerOf.length > 0 && operator !== true) {
            return { erased: false, soleOwnerOf };
        }

        await rewriteLegacySetRoleTargets(context, userId, new Set(memberships.map((membership) => membership.organizationId)));

        await (soleOwnerOf.length === 0 ? purgeScopedRows(context, ["members"], { userId }) : keepSoleOwnerships(context, memberships, new Set(soleOwnerOf.map((organization) => organization.id))));

        await anonymiseScopedRows(context, "auditLog", { actorUserId: userId }, () => {
            return { actorUserId: DELETED_ACTOR };
        });

        return operator === true ? { erased: true, retainedOwnerOf: soleOwnerOf } : { erased: true };
    });
