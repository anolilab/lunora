/**
 * The control plane's half of a self-service account deletion.
 *
 * better-auth's `user.deleteUser.beforeDelete` runs after the password (or
 * session freshness) check and before any auth row is removed, so a refusal
 * there leaves the account intact. Its database hook `user.delete.before` would
 * be the wrong place: better-auth deletes the user's sessions and linked
 * accounts before it fires, so refusing there would strand an account with no
 * way to sign in.
 *
 * The hook has no Lunora context, so it reaches `account.eraseUser` the way the
 * build runner reaches its mutations: an in-process call to the control plane's
 * own admin route, `POST /v1/account/erase` ({@link postAccountErase}, which the
 * operator's `removeUser` in `operator-removal.ts` uses too). It fails closed:
 * when the route cannot run, the deletion is refused rather than leaving the
 * memberships and the audit actor behind.
 */
import { NOOP_EXECUTION_CONTEXT } from "@lunora/runtime";
import { APIError } from "better-auth/api";

import type { AuthEnv } from "./auth";
import type { ControlPlaneEnv } from "./control-plane-env";

const ERASE_URL = "https://control-plane.internal/v1/account/erase";

/**
 * Call `POST /v1/account/erase` in-process with the admin token. `null` when no
 * admin token is configured, so the caller can refuse before anything runs.
 */
export const postAccountErase = async (env: AuthEnv, body: { operator?: true; userId: string }): Promise<Response | null> => {
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

/** Build the `beforeDelete` callback for `user.deleteUser`, over the worker env. */
export const beforeAccountDeletion =
    (env: AuthEnv) =>
    async (user: { id: string }): Promise<void> => {
        const response = await postAccountErase(env, { userId: user.id });

        if (response === null) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Account deletion is not available right now. Your account was not deleted." });
        }

        if (response.status === 409) {
            const { error } = await response.json<{ error: string }>();

            throw new APIError("BAD_REQUEST", { code: "SOLE_ORGANIZATION_OWNER", message: error });
        }

        if (!response.ok) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Your account data could not be removed. Your account was not deleted." });
        }
    };
