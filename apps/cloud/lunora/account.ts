import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "./_generated/server.js";
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

/** An organization named by an account deletion: one the user solely owns, or one left without an owner. */
export interface SoleOwnedOrganization {
    id: string;
    name: string;
}

/** The outcome of {@link eraseUser}. */
export interface EraseUserResult {
    /**
     * Organizations that had no owner left once the user's memberships were
     * removed: another owner left at the same moment (see {@link eraseUser}).
     * Each one also gets an `organization.ownerless` audit entry.
     */
    ownerless: SoleOwnedOrganization[];

    /**
     * Present only for an operator removal: the organizations the user was the
     * only owner of, whose owner membership the erasure kept. Each one also gets
     * an `organization.owner-removed` audit entry.
     */
    retainedOwnerOf?: SoleOwnedOrganization[];
}

/** The audit action recorded on an organization an account deletion left without an owner. */
export const OWNERLESS_ACTION = "organization.ownerless";

/** The actor of the audit entry that marks an organization whose removed owner's membership was kept. */
export const ERASURE_ACTOR = "system:account-erasure";

/** The action of that entry; support looks for it to transfer the ownership. */
export const OWNER_REMOVED_ACTION = "organization.owner-removed";

/**
 * The `target` of that entry: the kept membership's row id (which names no
 * person) and what support has to do. One entry per kept membership, so a
 * repeated removal does not add another; the orphaned-membership sweep looks it
 * up by this exact target to leave a kept membership alone.
 */
export const ownerRemovedTarget = (memberId: string): string =>
    `${memberId}: the only owner's account was removed; the membership is kept until support transfers ownership`;

/** The organizations of `ownerOf` (ids) that are live and have no owner other than `userId`. */
const organizationsWithoutOtherOwner = async (context: QueryContext, ownerOf: ReadonlyArray<string>, userId: string): Promise<SoleOwnedOrganization[]> => {
    const found: SoleOwnedOrganization[] = [];

    for (const organizationId of ownerOf) {
        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user owns few
        const organization = await context.db.organizations.get(organizationId as Id<"organizations">);

        // An organization already scheduled for deletion is removed by the purge anyway.
        if (organization === null || typeof organization.deletionRequestedAt === "number") {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one organization at a time; a user owns few
        const { page: owners } = await context.db.members.findMany({ where: { organizationId: organization._id, role: "owner" } });

        if (owners.every((row) => row.userId === userId)) {
            found.push({ id: organization._id, name: organization.name });
        }
    }

    return found;
};

/** The ids of the organizations `userId` is an owner of, among their `memberships`. */
const ownedOrganizationIds = (memberships: ReadonlyArray<{ organizationId: string; role: string }>): string[] =>
    memberships.filter((row) => row.role === "owner").map((row) => row.organizationId);

/**
 * The organizations that block deleting `userId`'s account: the ones they are
 * the only owner of, which would be left with nobody able to manage or delete
 * them. Writes nothing. Runs from the authentication layer's before-delete hook
 * through `POST /v1/account/erase` (`check: true`), before any auth row is
 * removed, so a refusal leaves the account intact. Only self-service deletion
 * is refused; an operator removal never is (see {@link eraseUser}). SYSTEM only.
 */
export const soleOwnedOrganizations = internalQuery
    .input({ userId: v.string() })
    .query(async ({ ctx: context, args: { userId } }): Promise<SoleOwnedOrganization[]> => {
        const { page: memberships } = await context.db.members.findMany({ where: { userId } });

        return organizationsWithoutOtherOwner(context, ownedOrganizationIds(memberships), userId);
    });

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
 * Mark each kept owner membership with an {@link OWNER_REMOVED_ACTION} entry by
 * {@link ERASURE_ACTOR}, unless an earlier run already did.
 */
const markKeptOwnerships = async (
    context: MutationContext,
    kept: ReadonlyArray<{ _id: Id<"members">; organizationId: Id<"organizations"> }>,
): Promise<void> => {
    for (const membership of kept) {
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
 * Remove what the control plane holds about a user whose account is being or
 * has been removed: the audit entries they authored stay for their retention
 * period with the actor replaced by {@link DELETED_ACTOR}, `member.set-role`
 * entries in the old format that name them by user id (see `setRoleAuditTarget`
 * in `members.ts`) are rewritten to name {@link DELETED_ACTOR}, in every
 * organization they were still a member of, and their memberships go.
 *
 * Never refuses. Two callers, told apart by `operator`:
 *
 * - Self-service (`operator` unset): runs AFTER the authentication layer deleted
 *   the account (its after-delete hook, through `POST /v1/account/erase`). The
 *   account is already gone, so a refusal would strand the rows; the sole-owner
 *   refusal happened earlier, in {@link soleOwnedOrganizations}. Every
 *   membership goes.
 * - Operator removal (`operator: true`): from the auth admin's `removeUser`,
 *   before its auth cascade, and from the orphaned-membership sweep, which acts
 *   on an account removed outside the self-service hooks. The user cannot be
 *   asked to transfer ownership first, so a sole owner's membership is kept and
 *   the organization is otherwise unchanged: handing it to another member would
 *   give it to someone who never accepted it. Each kept membership gets an
 *   {@link OWNER_REMOVED_ACTION} entry for support to transfer the ownership,
 *   and the organizations come back as `retainedOwnerOf`. Every other
 *   membership goes. The kept row is the one place the user's id stays, until
 *   support transfers the ownership or the organization is deleted.
 *
 * Every audit write happens before the memberships go, because the sweep finds
 * unfinished work by the memberships: a run cut short in between is still found.
 * Idempotent: a second run changes nothing, and finds the kept memberships
 * already marked.
 *
 * Not isolated: the tables are `.global()` (D1, which has no interactive
 * transaction), so another owner can leave an organization between the
 * before-delete check and these writes, and both departures succeed. The owners
 * of every organization whose membership went are re-read after the writes; one
 * with none left gets an {@link OWNERLESS_ACTION} audit entry and is returned so
 * the operator can assign one. The re-read narrows the race, it does not close
 * it: an owner who leaves after the re-read, while this was the last other
 * owner, is not caught here. Nothing is undone. SYSTEM only.
 */
export const eraseUser = internalMutation
    .input({ operator: v.optional(v.boolean()), userId: v.string() })
    .mutation(async ({ ctx: context, args: { operator, userId } }): Promise<EraseUserResult> => {
        const { page: memberships } = await context.db.members.findMany({ where: { userId } });
        const ownerOf = ownedOrganizationIds(memberships);
        const retainedOwnerOf = operator === true ? await organizationsWithoutOtherOwner(context, ownerOf, userId) : [];
        const retainedIds = new Set(retainedOwnerOf.map((organization) => organization.id));
        const kept = memberships.filter((membership) => retainedIds.has(membership.organizationId));

        await rewriteLegacySetRoleTargets(context, userId, new Set(memberships.map((membership) => membership.organizationId)));
        await anonymiseScopedRows(context, "auditLog", { actorUserId: userId }, () => {
            return { actorUserId: DELETED_ACTOR };
        });
        await markKeptOwnerships(context, kept);

        if (kept.length === 0) {
            await purgeScopedRows(context, ["members"], { userId });
        } else {
            for (const membership of memberships.filter((row) => !retainedIds.has(row.organizationId))) {
                // eslint-disable-next-line no-await-in-loop -- sequential deletes; a user is in few organizations
                await context.db.delete(membership._id);
            }
        }

        // The user has no membership left outside the kept ones, so "no owner other than userId" is "no owner".
        const ownerless = await organizationsWithoutOtherOwner(
            context,
            ownerOf.filter((organizationId) => !retainedIds.has(organizationId)),
            userId,
        );

        for (const organization of ownerless) {
            // eslint-disable-next-line no-await-in-loop -- one entry per ownerless organization; rare
            await context.db.insert("auditLog", {
                action: OWNERLESS_ACTION,
                actorUserId: DELETED_ACTOR,
                createdAt: context.now,
                organizationId: organization.id,
                target: "account-deletion",
            });
        }

        return operator === true ? { ownerless, retainedOwnerOf } : { ownerless };
    });
