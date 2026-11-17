import { ensureMigrated } from "@lunora/auth/migrate";

import { buildAuth, buildMigrationAuth } from "../../lunora/auth";

/** The bindings sign-in reads. */
export interface AuthEnv {
    AUTH_SECRET: string;
    DB: unknown;
}

let ready: Promise<ReturnType<typeof buildAuth>> | undefined;

/**
 * The auth instance, once its D1 tables exist. Memoised as one promise, so concurrent cold-start requests
 * all wait on the same migration. A failed migration clears the promise, so the next request retries.
 */
export const authFor = (env: AuthEnv): Promise<ReturnType<typeof buildAuth>> => {
    ready ??= (async () => {
        try {
            await ensureMigrated(buildMigrationAuth(env));

            return buildAuth(env);
        } catch (error) {
            ready = undefined;

            throw error;
        }
    })();

    return ready;
};
