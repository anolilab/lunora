/**
 * Public surface for Row-Level Security (PLAN2 §3.2).
 *
 *   import { definePolicy, definePolicies, defineRole, rls } from "@cirrus/server";
 *
 *   const userPolicy = definePolicy<MyCtx>({
 *     table: "documents",
 *     on: "read",
 *     when: ({ auth }) => ({ ownerId: auth.userId }),
 *   });
 *
 *   const policies = definePolicies([userPolicy]);
 *
 *   const builders = initCirrus.dataModel<DataModel>().create();
 *   const guardedQuery = builders.query.use(rls(policies));
 *
 * Opt-in scope is the load-bearing invariant: policies apply only to
 * procedures whose builder chain includes `.use(rls(...))`. A bare `query`
 * sees an unwrapped `ctx.db` and the policy list has no effect.
 *
 * `count()` against a policy-restricted table throws
 * `CirrusError("COUNT_RLS_UNSUPPORTED")` (422). Document this in any
 * code that wraps `ctx.db.<table>.count`.
 *
 * Permissions (`definePermission`/`grant`) are out of scope for v1; policies
 * branch on `ctx.auth.roles` (string list attached by the identity resolver).
 */
export { definePolicies, definePolicy, defineRole } from "./define.js";
export { rls } from "./middleware.js";
export type {
    DefinePolicyInput,
    Policy,
    PolicyContext,
    PolicyDecision,
    PolicyOperation,
    Role,
    WhereInput,
} from "./types.js";
