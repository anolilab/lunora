/**
 * The owner check and the cleanup around better-auth's `POST /admin/remove-user`,
 * the endpoint behind the auth UI's "remove user" action.
 *
 * That endpoint deletes the user's sessions and then the user, and runs neither
 * `user.deleteUser.beforeDelete` nor `afterDelete` (`src/account-deletion.ts`).
 * Left alone, an admin could remove an organization's only owner and leave the
 * organization without one, and the user's memberships would wait for the
 * orphaned-membership sweep. The admin plugin has no callback of its own, so this
 * plugin wraps the endpoint with hooks:
 *
 * - before: refuse while the user is the only owner of an organization. It only
 *   asks (`check: true`) and writes nothing. It runs before the endpoint's own
 *   permission check, so it first requires a session that may delete users, the
 *   same rule the admin plugin applies with its default roles; anyone else is
 *   refused here and never learns which organizations a user owns.
 * - after: once the endpoint has removed the user, run the same cleanup as a
 *   self-service deletion. better-auth runs after hooks for a refused call too,
 *   so the cleanup runs only for a successful one.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";

import { afterAccountDeletion, postAccountErase } from "./account-deletion";
import { ADMIN_ROLES } from "./admin-roles";
import type { AuthEnv } from "./auth";

const REMOVE_USER_PATH = "/admin/remove-user";

/**
 * Whether a session's role string grants `user:delete` under the role map the
 * admin plugin is configured with. Exported for the test that pins it.
 */
export const canDeleteUsers = (role: null | string | undefined, roles: Partial<typeof ADMIN_ROLES> = ADMIN_ROLES): boolean =>
    (role ?? "user").split(",").some((name) => roles[name as keyof typeof ADMIN_ROLES]?.authorize({ user: ["delete"] }).success === true);

const targetUserId = (body: unknown): string | undefined => {
    const userId = (body as null | { userId?: unknown } | undefined)?.userId;

    return typeof userId === "string" && userId !== "" ? userId : undefined;
};

const unavailable = (): APIError => new APIError("INTERNAL_SERVER_ERROR", { message: "Removing users is not available right now. The user was not removed." });

/** The better-auth plugin that holds `/admin/remove-user` to the owner rule and cleans up after it. */
export const adminRemovalGuard = (env: AuthEnv): BetterAuthPlugin => {
    return {
        hooks: {
            after: [
                {
                    handler: createAuthMiddleware(async (context) => {
                        const userId = targetUserId(context.body);
                        const { returned } = context.context;

                        if (userId === undefined || returned === undefined || isAPIError(returned) || returned instanceof Response) {
                            return;
                        }

                        await afterAccountDeletion(env)({ id: userId });
                    }),
                    matcher: (context) => context.path === REMOVE_USER_PATH,
                },
            ],
            before: [
                {
                    handler: createAuthMiddleware(async (context) => {
                        const session = await getSessionFromCtx(context);

                        // No session: the endpoint answers 401 itself.
                        if (session === null) {
                            return;
                        }

                        const sessionUser = session.user as { id: string; role?: null | string };

                        if (!canDeleteUsers(sessionUser.role)) {
                            throw new APIError("FORBIDDEN", { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS", message: "You are not allowed to delete users" });
                        }

                        const userId = targetUserId(context.body);

                        // A missing id or the admin's own: the endpoint refuses both.
                        if (userId === undefined || userId === sessionUser.id) {
                            return;
                        }

                        const response = await postAccountErase(env, { check: true, userId });

                        if (response === null) {
                            throw unavailable();
                        }

                        if (response.status === 409) {
                            const { organizations } = await response.json<{ organizations: { name: string }[] }>();
                            const names = organizations.map((organization) => `"${organization.name}"`).join(", ");

                            throw new APIError("BAD_REQUEST", {
                                code: "SOLE_ORGANIZATION_OWNER",
                                message: `The user is the only owner of ${names}. Promote another member to owner or delete the organization, then remove the user again.`,
                            });
                        }

                        if (!response.ok) {
                            throw unavailable();
                        }
                    }),
                    matcher: (context) => context.path === REMOVE_USER_PATH,
                },
            ],
        },
        id: "lunora-cloud-admin-removal-guard",
    };
};
