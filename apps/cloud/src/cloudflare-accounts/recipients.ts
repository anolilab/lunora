/**
 * Email addresses of control-plane users, by id — read from better-auth's
 * `user` table through the isolate's auth instance (`currentAuth`). Members
 * rows carry only the user id; the address lives with the account.
 *
 * Answers an empty map when auth has not been bootstrapped in this isolate (a
 * cron, or a unit test), so a caller that only wants defaults degrades to none
 * rather than failing.
 *
 * ponytail: a second, independent lookup of the same table is being added in
 * `src/auth.ts` (`authUserEmails`); once both land, this one should call that.
 */
import { currentAuth } from "../auth";

/** Ids looked up at most — an organization's owners and admins, never a whole roster. */
const MAX_USERS = 50;

/** `userIds` → their email addresses; ids with no user (or no address) are absent. */
export const userEmails = async (userIds: ReadonlyArray<string>): Promise<Map<string, string>> => {
    const auth = currentAuth();
    const ids = [...new Set(userIds)].slice(0, MAX_USERS);

    if (auth === null || ids.length === 0) {
        return new Map();
    }

    const context = await auth.$context;
    const users = await context.adapter.findMany<{ email?: unknown; id?: unknown }>({
        limit: ids.length,
        model: "user",
        where: [{ field: "id", operator: "in", value: ids }],
    });

    return new Map(
        users
            .filter((user): user is { email: string; id: string } => typeof user.id === "string" && typeof user.email === "string" && user.email !== "")
            .map((user) => [user.id, user.email]),
    );
};
