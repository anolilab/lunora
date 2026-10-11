/**
 * The orphaned-membership sweep: the durable half of an account deletion.
 *
 * The control plane's cleanup runs in better-auth's after-delete hook
 * (`src/account-deletion.ts`), once the account is gone. When that step fails —
 * the route errors, the isolate is evicted between the two writes — nothing
 * else records it, so this sweep finds the work again from the data: a
 * membership whose user the auth layer no longer has. It also covers an account
 * removed without the self-service hook, such as an operator deleting the user.
 *
 * The cleanup itself is not repeated here: each user is handed to the same
 * `POST /v1/account/erase` the hook calls, so there is one implementation.
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
    /** Run the control plane's cleanup for one deleted user; `false` when it failed. */
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
 * Erase the control-plane data of every user that still has a membership but
 * no account, up to {@link MAX_ERASURES_PER_TICK}. Walks the whole membership
 * table, so an orphan past the first page is found; only the erasures are capped.
 *
 * Fails closed: when the account lookup rejects, the sweep rejects before
 * erasing anything, because every id would otherwise read as deleted.
 */
export const runAccountErasureSweep = async (database: ControlPlaneDatabase, ports: AccountErasurePorts): Promise<AccountErasureSweepResult> => {
    const memberships = await drainTable<{ userId?: unknown }>(database, "members");
    const userIds = [...new Set(memberships.flatMap((row) => (typeof row.userId === "string" && row.userId !== "" ? [row.userId] : [])))];

    if (userIds.length === 0) {
        return { erased: [], failed: [] };
    }

    const existing = await ports.existingUserIds(userIds);
    const orphaned = userIds.filter((userId) => !existing.has(userId)).slice(0, MAX_ERASURES_PER_TICK);
    const result: AccountErasureSweepResult = { erased: [], failed: [] };

    for (const userId of orphaned) {
        // eslint-disable-next-line no-await-in-loop -- one user at a time; each erasure is several writes
        const ok = await ports.erase(userId).catch(() => false);

        (ok ? result.erased : result.failed).push(userId);
    }

    return result;
};
