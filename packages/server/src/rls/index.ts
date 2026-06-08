/**
 * Public surface for Row-Level Security (PLAN2 §3.2).
 *
 * ```ts
 * import { definePolicy, definePolicies, defineRole, rls } from "@cirrus/server";
 *
 * const userPolicy = definePolicy&lt;MyCtx>({
 *     table: "documents",
 *     on: "read",
 *     when: ({ auth }) => ({ ownerId: auth.userId }),
 * });
 *
 * const policies = definePolicies([userPolicy]);
 *
 * const builders = initCirrus.dataModel&lt;DataModel>().create();
 * const guardedQuery = builders.query.use(rls(policies));
 * ```
 *
 * Opt-in scope is the load-bearing invariant: policies apply only to
 * procedures whose builder chain includes `.use(rls(...))`. A bare `query`
 * sees an unwrapped `ctx.db` and the policy list has no effect.
 *
 * `count()` against a policy-restricted table throws
 * `CirrusError("COUNT_RLS_UNSUPPORTED")` (422). Document this in any
 * code that wraps `ctx.db.&lt;table>.count`.
 *
 * Permissions let a policy check a named capability instead of enumerating
 * roles. Declare them with `definePermission`, grant them via a role's
 * `permissions`, register the roles with the middleware, and check with
 * `ctx.auth.can(...)`:
 *
 * ```ts
 * const deletePosts = definePermission("posts:delete");
 * const admin = defineRole("admin", { permissions: [deletePosts] });
 *
 * const policy = definePolicy&lt;MyCtx>({
 *     table: "posts",
 *     on: "delete",
 *     when: ({ auth }) => auth.can(deletePosts),
 * });
 *
 * builders.mutation.use(rls(definePolicies([policy]), { roles: [admin] }));
 * ```
 */
export { definePermission, definePolicies, definePolicy, defineRole } from "./define.js";
export { rls } from "./middleware.js";
export type { DefinePolicyInput, Permission, Policy, PolicyContext, PolicyDecision, PolicyOperation, RlsOptions, Role, WhereInput } from "./types.js";
