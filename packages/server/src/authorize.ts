import { LunoraError } from "@lunora/errors";

import type { MiddlewareNext } from "./builder/types";

/**
 * Whether the caller holds the permission a procedure needs. It reads the
 * server-verified context, never a value from the request arguments.
 */
type AuthorizeCheck<Context> = (context: Context) => boolean | Promise<boolean>;

/**
 * Gate a procedure behind a permission check: the middleware throws `FORBIDDEN`
 * unless `check` passes. Use it in the builder chain of a procedure that only an
 * authenticated, permitted caller may reach:
 *
 * ```ts
 * export const addTeamMember = authMutation.use(authorize<{ user: { canManageTeamMembers: boolean } }>((ctx) => ctx.user.canManageTeamMembers));
 * ```
 *
 * It is also the marker the advisor reads. A procedure whose chain carries
 * `.use(authorize(...))` is behind an authenticated check, so the CAPTCHA lint does
 * not ask for one: a bot check protects unauthenticated sign-up, not an action a
 * permitted caller takes. The advisor trusts the declaration, not the check, so the
 * check itself must be the permission test.
 */
// Generic over the context the builder hands in, so `.use()` keeps every field of it: a gate that
// reads only `user` must not narrow the context the handler sees to `{ user }`.
const authorize =
    <Context extends object>(check: AuthorizeCheck<Context>) =>
    async <Current extends Context>({ ctx, next }: { ctx: Current; next: MiddlewareNext<Current> }): Promise<Current> => {
        if (!(await check(ctx))) {
            throw new LunoraError("FORBIDDEN", "Permission required");
        }

        return next();
    };

export type { AuthorizeCheck };
export { authorize };
