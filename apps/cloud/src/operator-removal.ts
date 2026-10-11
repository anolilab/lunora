/**
 * The control plane's half of an operator removing a user.
 *
 * The studio's auth admin plane (`createAuthAdmin`, behind the admin token)
 * deletes the authentication layer's rows for the user, and only those. Wrapped
 * here, `removeUser` first runs the same erasure as a self-service deletion,
 * `account.eraseUser` through `POST /v1/account/erase`, with `operator: true`,
 * and only then the auth cascade. It fails closed: when the erasure cannot run
 * the user is not removed, and since both halves are idempotent, removing the
 * user again is the recovery.
 *
 * An operator removal is refused, like a self-service one, while the user is
 * the only owner of an organization, so no organization is left without an
 * owner. The erasure writes nothing then, and the auth cascade never runs. The
 * operator promotes another member to owner (`POST /v1/organizations/owners`)
 * or deletes the organization, and removes the user again.
 */
import type { AuthAdmin } from "@lunora/auth";
import { LunoraAuthAdminError } from "@lunora/auth";

import { postAccountErase } from "./account-deletion";
import type { AuthEnv } from "./auth";

/** `admin`, with `removeUser` erasing the control plane's data about the user before the auth cascade. */
export const withControlPlaneErasure = (admin: AuthAdmin, env: AuthEnv): AuthAdmin => {
    return {
        ...admin,
        removeUser: async (input) => {
            const response = await postAccountErase(env, { operator: true, userId: input.userId });

            if (response?.status === 409) {
                const { error } = await response.json<{ error: string }>();

                throw new LunoraAuthAdminError(error, "LAST_ORGANIZATION_OWNER");
            }

            if (!response?.ok) {
                throw new LunoraAuthAdminError(
                    `the control plane's data about the user could not be erased (${response === null ? "no admin token configured" : `status ${String(response.status)}`}); the user was not removed`,
                    "ACCOUNT_ERASURE_FAILED",
                );
            }

            await admin.removeUser(input);
        },
    };
};
