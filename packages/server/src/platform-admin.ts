import { LunoraError } from "@lunora/errors";

import type { Middleware } from "./builder/types";

/**
 * Whether the caller is a platform admin. It reads the server-verified context —
 * the session user, never a value from the request arguments.
 */
type PlatformAdminCheck<Context> = (context: Context) => boolean | Promise<boolean>;

/**
 * Gate a procedure to platform admins: the middleware throws `FORBIDDEN` unless
 * `check` passes. Use it in the builder chain of an admin procedure:
 *
 * ```ts
 * export const adminMutation = authMutation.use(platformAdmin((ctx) => ctx.user.isAdmin === true));
 * ```
 *
 * It is also the marker the advisor reads. A procedure whose chain carries
 * `.use(platformAdmin(...))` is reachable only by an admin, so the ownership lint
 * treats the arguments it takes as the admin's choice rather than an IDOR. The
 * marker is the import, not the name of the variable that holds the chain.
 */
const platformAdmin =
    <Context extends object>(check: PlatformAdminCheck<Context>): Middleware<Context, Context> =>
    async ({ ctx, next }) => {
        if (!(await check(ctx))) {
            throw new LunoraError("FORBIDDEN", "Platform admin access required");
        }

        return next();
    };

export type { PlatformAdminCheck };
export { platformAdmin };
