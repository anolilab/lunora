/**
 * The orphaned-membership sweep: the durable half of an account deletion.
 *
 * The control plane's cleanup runs in better-auth's after-delete hook
 * (`src/account-deletion.ts`), once the account is gone. When that step fails —
 * the route errors, the isolate is evicted between the two writes — nothing
 * else records it, so this sweep finds the work again from the data: a
 * membership whose user the auth layer no longer has. It also covers an account
 * removed without either hook, such as through the auth admin plugin's own
 * endpoint rather than the wrapped `removeUser` (`src/operator-removal.ts`).
 *
 * The cleanup itself is not repeated here: each user is handed to the same
 * `POST /v1/account/erase` the hooks call, so there is one implementation. It is
 * called as an operator removal (`operator: true`): the account is gone without
 * the self-service check, so a sole owner's membership is kept and marked for
 * support rather than leaving the organization without an owner.
 *
 * Such a kept membership belongs to a user the auth layer no longer has, by
 * design. While it is still its organization's only owner it is recognised by
 * its `organization.owner-removed` audit entry and left out, so it is neither
 * erased nor counted against the per-tick cap on every tick. Once support has
 * given the organization another owner, it is erased like any other orphan.
 *
 * Residual case: a user who had no memberships but did author audit entries,
 * and whose after-delete step failed, keeps their id on those entries until the
 * audit retention prunes them. The audit log has no index on the actor, so a
 * fleet-wide scan of it every hour is not worth that case.
 */
import { OWNER_REMOVED_ACTION, ownerRemovedTarget } from "../../lunora/account";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";

/** Users erased per tick at most; the rest are found again on the next one. */
export const MAX_ERASURES_PER_TICK = 25;

/** What the sweep needs from outside the store. */
export interface AccountErasurePorts {
    /** Run the control plane's cleanup for one deleted user, as an operator removal; `false` when it failed. */
    erase: (userId: string) => Promise<boolean>;
    /** Which of `userIds` still have an account. Rejects when the lookup fails; it must never answer partially. */
    existingUserIds: (userIds: ReadonlyArray<string>) => Promise<Set<string>>;
}

/** The outcome of one sweep, for its tests and its log line. */
export interface AccountErasureSweepResult {
    erased: string[];
    failed: string[];
}

/**
 * Whether `membership` is an owner membership an operator removal kept and that
 * is still needed: it carries its audit mark, and `ownersByOrganization` counts
 * no other owner in its organization.
 */
const isKeptOwnership = async (
    database: ControlPlaneDatabase,
    membership: Membership,
    ownersByOrganization: ReadonlyMap<unknown, number>,
): Promise<boolean> => {
    if (membership.role !== "owner" || typeof membership._id !== "string" || typeof membership.organizationId !== "string") {
        return false;
    }

    if ((ownersByOrganization.get(membership.organizationId) ?? 0) > 1) {
        return false;
    }

    const { page } = await database.findMany("auditLog", {
        limit: 1,
        where: { action: OWNER_REMOVED_ACTION, organizationId: membership.organizationId, target: ownerRemovedTarget(membership._id) },
    });

    return page.length > 0;
};

interface Membership {
    _id?: unknown;
    organizationId?: unknown;
    role?: unknown;
    userId?: unknown;
}

/** The memberships per user, and the number of owners per organization. */
const groupMemberships = (memberships: ReadonlyArray<Membership>): { byUser: Map<string, Membership[]>; ownersByOrganization: Map<unknown, number> } => {
    const byUser = new Map<string, Membership[]>();
    const ownersByOrganization = new Map<unknown, number>();

    for (const row of memberships) {
        if (row.role === "owner") {
            ownersByOrganization.set(row.organizationId, (ownersByOrganization.get(row.organizationId) ?? 0) + 1);
        }

        if (typeof row.userId === "string" && row.userId !== "") {
            byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
        }
    }

    return { byUser, ownersByOrganization };
};

/**
 * Erase the control-plane data of every user that still has a membership but
 * no account, up to {@link MAX_ERASURES_PER_TICK}. Walks the whole membership
 * table, so an orphan past the first page is found; only the erasures are capped.
 * A user whose every remaining membership is a kept, marked ownership that is
 * still its organization's only owner is done.
 *
 * Fails closed: when the account lookup rejects, the sweep rejects before
 * erasing anything, because every id would otherwise read as deleted.
 */
export const runAccountErasureSweep = async (database: ControlPlaneDatabase, ports: AccountErasurePorts): Promise<AccountErasureSweepResult> => {
    const { byUser, ownersByOrganization } = groupMemberships(await drainTable<Membership>(database, "members"));

    if (byUser.size === 0) {
        return { erased: [], failed: [] };
    }

    const existing = await ports.existingUserIds([...byUser.keys()]);
    const result: AccountErasureSweepResult = { erased: [], failed: [] };

    for (const [userId, rows] of byUser) {
        if (existing.has(userId)) {
            continue;
        }

        if (result.erased.length + result.failed.length >= MAX_ERASURES_PER_TICK) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- one orphan at a time; a kept ownership is rare
        const kept = await Promise.all(rows.map((row) => isKeptOwnership(database, row, ownersByOrganization)));

        if (kept.every(Boolean)) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one user at a time; each erasure is several writes
        const ok = await ports.erase(userId).catch(() => false);

        (ok ? result.erased : result.failed).push(userId);
    }

    return result;
};
