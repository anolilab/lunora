/**
 * Public types for the Row-Level Security DSL (PLAN2 §3.2).
 *
 * Policies are pure functions: they read the request context (and, on writes,
 * the candidate row) and return a `WhereInput` predicate, a boolean, or
 * `undefined` to opt out. They never mutate state.
 *
 * The middleware (`rls(policies)`) installs into a builder via `.use()` —
 * policies only apply to procedures whose chain includes that middleware, so
 * RLS is opt-in per procedure, never global.
 *
 * NOTE on the `WhereInput` shape: re-declared structurally here to avoid a
 * runtime dependency on `@lunora/do`. It must stay assignable to
 * `@lunora/do`'s `WhereInput` — the runtime threads policy predicates
 * through that package's compiler unchanged.
 */

import type { WhereOf } from "../data-model";

/** Structural mirror of `@lunora/do`'s `WhereInput`. */
export interface WhereInput {
    [field: string]: unknown;
    AND?: WhereInput[];
    NOT?: WhereInput;
    OR?: WhereInput[];
}

/** Operations a policy can gate. `read` covers `get`/`findMany`/`query`/`count`. */
export type PolicyOperation = "delete" | "insert" | "read" | "update";

/**
 * A policy's `when` decision:
 *
 * - `WhereInput`: a row-shape predicate. On reads it is AND-merged into every
 * query against the table — the row is invisible unless it matches. On writes
 * it is evaluated against the candidate document (`insert`) or the pre-write
 * row (`update`/`delete`); a mismatch denies the write with
 * `LunoraError("FORBIDDEN")`. Same operator set as the SQL compiler
 * (`eq`/`ne`/`in`/`notIn`/`lt`/`lte`/`gt`/`gte`/`isNull`/`contains` +
 * `AND`/`OR`/`NOT`).
 * - `true`: unrestricted. On reads no predicate is merged; on writes the row is
 * allowed.
 * - `false`: deny. On reads the table is forced to match zero rows (a sentinel
 * predicate); on writes the operation throws `LunoraError("FORBIDDEN")`.
 *
 * Returning `undefined` opts this specific policy out (rare; useful when
 * branching on `ctx.auth.roles`).
 */
export type PolicyDecision = WhereInput | boolean | undefined;

/**
 * Relation-aware twin of {@link PolicyDecision}, parameterized over the
 * generated `DataModel` (`DM`) + `Relations` (`REL`) maps and a table `T`. A
 * read policy may now return a Prisma-style relation predicate (the
 * `@lunora/do` pre-resolver resolves it via a semijoin), so the typed
 * authoring surface accepts `WhereOf<DM, REL, T>` — column predicates **and**
 * `is`/`isNot`/`some`/`none`/`every` over `T`'s declared relations — in
 * addition to the `boolean`/`undefined` decisions. Used by the project-bound
 * `definePolicy` from `createPolicyDsl`.
 */
export type PolicyDecisionOf<DM, REL extends Record<keyof DM, object>, T extends keyof DM> = WhereOf<DM, REL, T> | boolean | undefined;

/**
 * Relation-aware input for a project-bound `definePolicy` (see
 * `createPolicyDsl`). `table` is constrained to a real table name and
 * `when`'s return type is the table-specific {@link PolicyDecisionOf} — so an
 * unknown table, a stray column, or a relation predicate naming a relation the
 * table does not declare is a compile error rather than a silent runtime deny.
 */
export interface TypedDefinePolicyInput<DM, REL extends Record<keyof DM, object>, T extends keyof DM, Context = unknown, Identity = Record<string, unknown>> {
    on: PolicyOperation;
    table: T;
    when: (context: PolicyContext<Context, Identity>) => PolicyDecisionOf<DM, REL, T>;
}

/**
 * Context handed to a policy. `auth.roles` is the per-request role list,
 * sourced from the identity resolver (better-auth claims today). `auth.can`
 * answers whether any of those roles grants a permission (see
 * {@link Permission} / {@link RlsOptions}). `row` is present only on write
 * policies (`insert`/`update`/`delete`) — for `update` and `delete` it is the
 * pre-write row; for `insert` it is the candidate document. `ctx` is the full
 * procedure context the middleware closed over.
 */
export interface PolicyContext<Context = unknown, Identity = Record<string, unknown>> {
    readonly auth: {
        /**
         * `true` when any of the request's `roles` grants `permission` (passed
         * by {@link Permission} object or its `name`). Always `false` when no
         * roles were handed to the middleware (`rls(policies, { roles })`), or
         * when none of the request's roles lists the permission.
         */
        readonly can: (permission: Permission | string) => boolean;

        /**
         * The resolved identity, typed to the `Identity` type parameter bound on
         * `createPolicyDsl` — e.g. the app's `defineIdentity(...)` claim type via
         * the `InferIdentity` helper; otherwise the untyped claim bag.
         * `undefined`/`null` when the request is anonymous.
         */
        readonly identity?: Identity | null;
        readonly roles: ReadonlyArray<string>;
        readonly userId: null | string;
    };
    readonly ctx: Context;
    readonly row?: Record<string, unknown>;
}

/** A registered policy as stored in the policy table. */
export interface Policy<Context = unknown> {
    readonly on: PolicyOperation;
    readonly table: string;
    readonly when: (context: PolicyContext<Context>) => PolicyDecision;
}

/**
 * Input accepted by `definePolicy`. The branded result is the same
 * shape; we keep the input/output split so callers can read JSDoc on the
 * constructor without the type re-exposing `Policy` internals.
 */
export interface DefinePolicyInput<Context = unknown> {
    on: PolicyOperation;
    /** Logical table name the policy applies to. */
    table: string;

    /* eslint-disable no-secrets/no-secrets -- JSDoc names a stable error-kind constant, not a secret */

    /**
     * Decision function. Returning a `WhereInput` (read only) AND-merges the
     * predicate; `true` allows; `false` denies; `undefined` skips this policy.
     *
     * NOTE: `count()` is **unsupported** on a policy-restricted table — the
     * reader throws `LunoraError("COUNT_RLS_UNSUPPORTED")` (422). This mirrors
     * kitcn's documented behavior.
     */
    /* eslint-enable no-secrets/no-secrets */
    when: (context: PolicyContext<Context>) => PolicyDecision;
}

/**
 * A named, abstract capability a policy can check with `ctx.auth.can(...)`,
 * instead of branching on raw role strings. Declare one with
 * `definePermission`; grant it to a role via {@link Role.permissions};
 * register the roles with the middleware via {@link RlsOptions.roles}.
 */
export interface Permission {
    readonly description?: string;
    readonly name: string;
}

/**
 * A role declaration. Roles are string labels attached to the request's
 * identity (via better-auth claims today). `permissions` lists the
 * capabilities the role grants — at request time the middleware unions the
 * permissions of every role in `ctx.auth.roles` so a policy can ask
 * `ctx.auth.can(permission)` rather than enumerate roles.
 */
export interface Role {
    readonly description?: string;
    readonly name: string;
    /** Permissions this role grants — by {@link Permission} object or bare name. */
    readonly permissions?: ReadonlyArray<Permission | string>;
}

/**
 * Options for the `rls(policies, options)` middleware. `roles` registers the
 * role→permission grants that back `ctx.auth.can(...)`; a role not listed here
 * grants no permissions (so `can` is conservative — it fails closed for
 * unknown roles).
 */
export interface RlsOptions {
    readonly roles?: ReadonlyArray<Role>;
}
