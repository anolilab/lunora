/**
 * The control plane's half of an operator removing a user.
 *
 * The studio's auth admin plane (`createAuthAdmin`, behind the admin token)
 * deletes the authentication layer's rows for the user, and only those. Wrapped
 * here, `removeUser` runs the same steps as a self-service deletion
 * (`src/account-deletion.ts`), in the same order:
 *
 * 1. Check, writing nothing: refuse while the user is the only owner of an
 *    organization, so no organization is left without an owner. A failed check
 *    means the user is not removed.
 * 2. The auth cascade.
 * 3. The control plane's cleanup, `account.eraseUser`, through
 *    `POST /v1/account/erase`. It cannot refuse once the account is gone. If it
 *    fails, the failure is logged and the orphaned-membership sweep
 *    (`src/sweeps/account-erasure.ts`) finishes it.
 *
 * Cleanup before the auth cascade, as this used to be, left a live account with
 * no memberships whenever the cascade failed. The operator promotes another
 * member to owner (`POST /v1/organizations/owners`) or deletes the organization
 * when a removal is refused, then removes the user again.
 */
import type { AuthAdmin } from "@lunora/auth";
import { LunoraAuthAdminError } from "@lunora/auth";

import { afterAccountDeletion, postAccountErase } from "./account-deletion";
import type { AuthEnv } from "./auth";

/** `admin`, with `removeUser` checking the control plane's data about the user, then cleaning it up after the auth cascade. */
export const withControlPlaneErasure = (admin: AuthAdmin, env: AuthEnv): AuthAdmin => {
    return {
        ...admin,
        removeUser: async (input) => {
            const check = await postAccountErase(env, { check: true, userId: input.userId });

            if (check?.status === 409) {
                const { error } = await check.json<{ error: string }>();

                throw new LunoraAuthAdminError(error, "LAST_ORGANIZATION_OWNER");
            }

            if (!check?.ok) {
                throw new LunoraAuthAdminError(
                    `the control plane's data about the user could not be checked (${check === null ? "no admin token configured" : `status ${String(check.status)}`}); the user was not removed`,
                    "ACCOUNT_ERASURE_FAILED",
                );
            }

            await admin.removeUser(input);
            await afterAccountDeletion(env)({ id: input.userId });
        },
    };
};
