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
 * called as an operator removal (`operator: true`), which is refused while the
 * user is the only owner of an organization.
 *
 * Such a user is left for the operator and not touched: erasing their
 * membership would leave the organization without an owner, and keeping it as a
 * special case would keep the removed user's id without a reason. The erasure
 * decides, with the same rule as every other operator removal, and writes
 * nothing when it refuses; the sweep reports the user in `leftForOperator`. A
 * user who looks like a sole owner in the membership table is handed to the
 * erasure even once the per-tick cap is reached, so every one is reported on
 * every tick. The operator promotes another member to owner or deletes the
 * organization, and the next tick erases the user like any other orphan.
 *
 * Residual case: a user who had no memberships but did author audit entries,
 * and whose after-delete step failed, keeps their id on those entries until the
 * audit retention prunes them. The audit log has no index on the actor, so a
 * fleet-wide scan of it every hour is not worth that case.
 */
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";

/** Users erased per tick at most; the rest are found again on the next one. */
export const MAX_ERASURES_PER_TICK = 25;

/** What the sweep needs from outside the store. */
export interface AccountErasurePorts {
    /**
     * Run the control plane's cleanup for one deleted user, as an operator removal:
     * `true` when it ran, `false` when it failed, and the ids of the organizations
     * the user is the only owner of when it was refused.
     */
    erase: (userId: string) => Promise<boolean | { refused: string[] }>;
    /** Which of `userIds` still have an account. Rejects when the lookup fails; it must never answer partially. */
    existingUserIds: (userIds: ReadonlyArray<string>) => Promise<Set<string>>;
}

/** A deleted user the sweep did not touch because they are the only owner of these organizations. */
export interface SoleOwnerLeftForOperator {
    organizationIds: string[];
    userId: string;
}

/** The outcome of one sweep, for its tests and its log line. */
export interface AccountErasureSweepResult {
    erased: string[];
    failed: string[];
    leftForOperator: SoleOwnerLeftForOperator[];
}

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
 * Whether `rows` holds the only owner membership of an organization, by the
 * membership table alone. Only a hint: the erasure also skips an organization
 * that is gone or scheduled for deletion.
 */
const looksLikeSoleOwner = (rows: ReadonlyArray<Membership>, ownersByOrganization: ReadonlyMap<unknown, number>): boolean =>
    rows.some((row) => row.role === "owner" && (ownersByOrganization.get(row.organizationId) ?? 0) <= 1);

/** Erase one deleted user and record the outcome. */
const eraseOne = async (ports: AccountErasurePorts, userId: string, result: AccountErasureSweepResult): Promise<void> => {
    const outcome = await ports.erase(userId).catch(() => false);

    if (typeof outcome === "object") {
        result.leftForOperator.push({ organizationIds: outcome.refused, userId });
    } else {
        (outcome ? result.erased : result.failed).push(userId);
    }
};

/**
 * Erase the control-plane data of every user that still has a membership but
 * no account, up to {@link MAX_ERASURES_PER_TICK}. Walks the whole membership
 * table, so an orphan past the first page is found; only the erasures are capped.
 * A user the erasure refuses as the only owner of an organization is reported
 * in `leftForOperator` and not touched, and does not count against the cap.
 *
 * Fails closed: when the account lookup rejects, the sweep rejects before
 * erasing anything, because every id would otherwise read as deleted.
 */
export const runAccountErasureSweep = async (database: ControlPlaneDatabase, ports: AccountErasurePorts): Promise<AccountErasureSweepResult> => {
    const { byUser, ownersByOrganization } = groupMemberships(await drainTable<Membership>(database, "members"));
    if (byUser.size === 0) {
        return { erased: [], failed: [], leftForOperator: [] };
    }

    const existing = await ports.existingUserIds([...byUser.keys()]);
    const result: AccountErasureSweepResult = { erased: [], failed: [], leftForOperator: [] };

    for (const [userId, rows] of byUser) {
        if (existing.has(userId)) {
            continue;
        }

        // Past the cap, only a likely sole owner is still handed to the erasure, so every refusal is reported.
        if (!looksLikeSoleOwner(rows, ownersByOrganization) && result.erased.length + result.failed.length >= MAX_ERASURES_PER_TICK) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one user at a time; each erasure is several writes
        await eraseOne(ports, userId, result);
    }

    return result;
};
