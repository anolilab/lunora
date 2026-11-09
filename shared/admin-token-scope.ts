/**
 * The scopes a named admin token can be minted with. A token with no scope can do everything a named token can do,
 * and nothing a scope unlocks. A scope unlocks one narrow surface; the root token is the only thing that unlocks the rest.
 *
 * Not a package: the worker, the shard and the CLI import it by relative path and the bundler inlines it. Keep it
 * zero-dependency.
 */

/** `migrations`: run the SQL migration files, but only their additive statements (see `@lunora/d1`'s `additiveOnly`). */
const ADMIN_TOKEN_SCOPES = ["migrations"] as const;

type AdminTokenScope = (typeof ADMIN_TOKEN_SCOPES)[number];

const isAdminTokenScope = (value: unknown): value is AdminTokenScope => typeof value === "string" && (ADMIN_TOKEN_SCOPES as readonly string[]).includes(value);

export { ADMIN_TOKEN_SCOPES, isAdminTokenScope };
export type { AdminTokenScope };
