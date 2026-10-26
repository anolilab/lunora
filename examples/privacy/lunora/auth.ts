import type { LunoraAuthOptions } from "@lunora/auth";
import { createAuth, lunoraD1Adapter } from "@lunora/auth";
import { createMigrationAuth } from "@lunora/auth/migrate";

/** Shown in the sign-in emails. */
const APP_NAME = "Lunora Privacy Example";

/**
 * Email and password sign-in and nothing else. The tables this creates in D1 are better-auth's `user`,
 * `session` and `account`, which `authDataset()` in `privacy.ts` names.
 *
 * `baseURL` is deliberately absent, as in `examples/auth-playground`: an explicit `http://` origin marks
 * the deployment local and turns off secure cookies, so better-auth resolves the origin per request.
 */
const options = (env: { AUTH_SECRET: string }): LunoraAuthOptions => {
    return {
        appName: APP_NAME,
        emailAndPassword: { enabled: true },
        secret: env.AUTH_SECRET,
    };
};

/** The runtime instance, over `lunoraD1Adapter`, which wires the adapter explicitly (see its doc comment). */
export const buildAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: lunoraD1Adapter(env.DB as never) });

/** The migration-only instance over raw D1, so `ensureMigrated` can create the tables the runtime reads. */
export const buildMigrationAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createMigrationAuth> =>
    createMigrationAuth({ ...options(env), database: env.DB as never });
