/**
 * The control plane's half of a self-service account deletion, in two steps
 * around better-auth's own deletion of the account:
 *
 * 1. `user.deleteUser.beforeDelete` runs after the password (or session
 *    freshness) check and before any auth row is removed. It only checks that
 *    the user is not the only owner of an organization, and writes nothing, so
 *    a refusal there leaves both the account and the control plane intact.
 * 2. `user.deleteUser.afterDelete` runs once the user row and sessions are gone,
 *    and removes the memberships and anonymises the audit actor.
 *
 * The cleanup used to run in step 1, so an auth deletion that failed after it
 * left a live account with no memberships. Now a failure can only leave the
 * opposite: a deleted account whose memberships remain. That is recoverable
 * without the user, and the orphaned-membership sweep
 * (`src/sweeps/account-erasure.ts`) re-runs the cleanup for it. So the
 * after-delete step logs a failure rather than throwing it: the account is
 * already gone, and an error response would tell the user it was not.
 *
 * better-auth's database hook `user.delete.before` would be the wrong place for
 * step 1: better-auth deletes the user's sessions and linked accounts before it
 * fires, so refusing there would strand an account with no way to sign in.
 *
 * The hooks have no Lunora context, so they reach the control plane the way the
 * build runner reaches its mutations: an in-process call to its own admin route,
 * `POST /v1/account/erase` ({@link postAccountErase}).
 */
import { NOOP_EXECUTION_CONTEXT } from "@lunora/runtime";
import { APIError } from "better-auth/api";

import type { AuthEnv } from "./auth";
import type { ControlPlaneEnv } from "./control-plane-env";

const ERASE_URL = "https://control-plane.internal/v1/account/erase";

/**
 * Call `POST /v1/account/erase` in-process; `null` when the admin token it is
 * gated on is not configured, so the caller can refuse before anything runs.
 * The operator's `removeUser` (`operator-removal.ts`) calls it with `check: true`
 * before the auth cascade, and with the bare form after it.
 */
export const postAccountErase = async (env: AuthEnv, body: { check?: true; operator?: true; userId: string }): Promise<null | Response> => {
    const token = env.LUNORA_ADMIN_TOKEN;

    if (typeof token !== "string" || token === "") {
        return null;
    }

    // Imported here, not at the top: the worker module imports this file's
    // importer (`auth.ts`), and a static import would close that cycle.
    const { controlPlaneWorker } = await import("./control-plane-worker");

    return controlPlaneWorker(env as unknown as ControlPlaneEnv).fetch(
        new Request(ERASE_URL, {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
        }),
        env,
        NOOP_EXECUTION_CONTEXT,
    );
};

/**
 * Build the `beforeDelete` callback for `user.deleteUser`, over the worker env.
 * Fails closed: when the check cannot run, the deletion is refused.
 */
export const beforeAccountDeletion =
    (env: AuthEnv) =>
    async (user: { id: string }): Promise<void> => {
        const response = await postAccountErase(env, { check: true, userId: user.id });

        if (response === null) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Account deletion is not available right now. Your account was not deleted." });
        }

        if (response.status === 409) {
            const { error } = await response.json<{ error: string }>();

            throw new APIError("BAD_REQUEST", { code: "SOLE_ORGANIZATION_OWNER", message: error });
        }

        if (!response.ok) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Account deletion is not available right now. Your account was not deleted." });
        }
    };

/**
 * Build the `afterDelete` callback for `user.deleteUser`, over the worker env.
 * Never throws: a failed cleanup is logged and left to the orphaned-membership
 * sweep, which finds the memberships of a user the auth layer no longer has.
 */
export const afterAccountDeletion =
    (env: AuthEnv) =>
    async (user: { id: string }): Promise<void> => {
        try {
            const response = await postAccountErase(env, { userId: user.id });

            if (!response?.ok) {
                // eslint-disable-next-line no-console -- the sweep retries it; this is the record that it had to
                console.error("[account] cleanup after account deletion failed; the orphaned-membership sweep will retry it", response?.status);
            }
        } catch (error) {
            // eslint-disable-next-line no-console -- the sweep retries it; this is the record that it had to
            console.error("[account] cleanup after account deletion failed; the orphaned-membership sweep will retry it", error);
        }
    };
