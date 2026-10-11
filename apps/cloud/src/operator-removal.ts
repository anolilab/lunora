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
 * An operator removal is never refused for a sole owner. Those organizations
 * keep the user's owner membership, so none is left without an owner, and come
 * back as `retainedOwnerOf`; `account.eraseUser` marks each with an audit entry
 * for support to transfer the ownership, and they are logged here for whoever
 * watches the worker's logs, because `removeUser` returns nothing the studio
 * could show.
 */
import type { AuthAdmin } from "@lunora/auth";
import { LunoraAuthAdminError } from "@lunora/auth";

import type { SoleOwnedOrganization } from "../lunora/account";
import { postAccountErase } from "./account-deletion";
import type { AuthEnv } from "./auth";

/** `admin`, with `removeUser` erasing the control plane's data about the user before the auth cascade. */
export const withControlPlaneErasure = (admin: AuthAdmin, env: AuthEnv): AuthAdmin => {
    return {
        ...admin,
        removeUser: async (input) => {
            const response = await postAccountErase(env, { operator: true, userId: input.userId });

            if (!response?.ok) {
                throw new LunoraAuthAdminError(
                    `the control plane's data about the user could not be erased (${response === null ? "no admin token configured" : `status ${String(response.status)}`}); the user was not removed`,
                    "ACCOUNT_ERASURE_FAILED",
                );
            }

            const { retainedOwnerOf } = await response.json<{ retainedOwnerOf?: SoleOwnedOrganization[] }>();

            if (retainedOwnerOf !== undefined && retainedOwnerOf.length > 0) {
                // eslint-disable-next-line no-console -- also kept as an audit entry in each organization; this is the operator's copy
                console.warn(
                    "[account-erasure]",
                    // The organizations only: the removed user's id is what the erasure takes out.
                    `an operator removal kept the owner membership of these organizations until support transfers it: ${retainedOwnerOf.map((organization) => organization.id).join(", ")}`,
                );
            }

            await admin.removeUser(input);
        },
    };
};
