/**
 * In-process RLS test harness.
 *
 * Policies are pure functions, so the cheapest way to test them is to evaluate
 * the *same* logic the `rls()` middleware runs — without a Worker, a Durable
 * Object, or a live socket. `expectPolicy(policies)` does exactly that: it
 * reuses the middleware's own {@link computeReadBaseWhere} / {@link evaluateWrite}
 * / {@link matchesWhere} primitives (re-exported from `./middleware`) so a green
 * test means the policy behaves identically in production, not merely in a
 * lookalike re-implementation.
 * @example
 * ```ts
 * import { definePolicy, definePolicies } from "@lunora/server";
 * import { expectPolicy } from "@lunora/server/rls/testing";
 *
 * const policies = definePolicies([
 *     definePolicy({ table: "docs", on: "read", when: ({ auth }) => ({ ownerId: auth.userId }) }),
 *     definePolicy({ table: "docs", on: "insert", when: ({ auth, row }) => row?.ownerId === auth.userId }),
 * ]);
 *
 * const ada = expectPolicy(policies).as({ userId: "ada" });
 *
 * ada.can("read", "docs", { ownerId: "ada" });   // true  — her row is visible
 * ada.can("read", "docs", { ownerId: "linus" }); // false — filtered out
 * ada.can("insert", "docs", { ownerId: "ada" }); // true
 * ada.cannot("insert", "docs", { ownerId: "x" }); // true  — denied
 * ```
 */
import { computeReadBaseWhere, evaluateWrite, indexRolePermissions, matchesWhere, resolveCan } from "./middleware";
import type { Policy, PolicyContext, PolicyOperation, Role, WhereInput } from "./types";

/**
 * The slice of a request identity a policy reads. Mirrors the
 * `PolicyContext.auth` shape the middleware builds at request time — every
 * field is optional and defaults the same way the middleware defaults it
 * (`userId`/`identity` → `null`, `roles` → `[]`).
 */
export interface TestIdentity {
    /** Raw identity claims a policy may branch on (`auth.identity.email`, …). */
    identity?: Record<string, unknown> | null;
    /** Role labels the request carries; resolved to permissions via the harness `roles` registry. */
    roles?: ReadonlyArray<string>;
    /** The caller id (`auth.userId`); `null`/omitted is the anonymous caller. */
    userId?: null | string;
}

/** Options for {@link expectPolicy}. */
export interface ExpectPolicyOptions<Context = unknown> {
    /**
     * The procedure context a policy reads via `ctx` (e.g. `ctx.orgId`). Held
     * for the whole harness; pass a fresh `expectPolicy(..., { ctx })` for a
     * different context. Defaults to an empty object.
     */
    ctx?: Context;

    /**
     * Role→permission grants backing `auth.can(...)` — the same registry passed
     * to `rls(policies, { roles })`. A role not listed here grants nothing, so
     * `can(...)` fails closed exactly as it does in production.
     */
    roles?: ReadonlyArray<Role>;
}

/** A harness bound to one identity; answers can/cannot for an `(op, table, row)`. */
export interface BoundPolicyAssertion {
    /**
     * Would this identity be **allowed** the operation on `row`?
     *
     * - `read` — is `row` visible? `true` when the table has no read policy (unrestricted), or when the effective read `baseWhere` matches `row`.
     * - `insert` — is the candidate `row` allowed by the insert policies?
     * - `update` / `delete` — is the pre-write `row` allowed? For `update` pass `nextRow` to also assert the post-image (WITH CHECK) — a policy can't be satisfied by the old row while the patch reassigns it to another tenant.
     *
     * A table with **no** policy in the list is unguarded → always `true`
     * (mirrors the middleware passing such tables through unwrapped). A table
     * that participates but declares no policy for the write `op` denies
     * (default-DENY), exactly as the middleware does.
     */
    can: (op: PolicyOperation, table: string, row?: Record<string, unknown>, nextRow?: Record<string, unknown>) => boolean;
    /** Negation of {@link BoundPolicyAssertion.can} — reads more naturally in a denial test. */
    cannot: (op: PolicyOperation, table: string, row?: Record<string, unknown>, nextRow?: Record<string, unknown>) => boolean;
}

/** A harness over a policy set; `.as(identity)` binds an identity to assert against. */
export interface PolicyAssertion {
    /** Bind an identity (or `null`/omitted for the anonymous caller) and assert against it. */
    as: (identity?: TestIdentity | null) => BoundPolicyAssertion;
}

/**
 * Build an in-process assertion harness over a policy set. Reuses the `rls()`
 * middleware's own evaluation primitives, so an assertion is faithful to
 * request-time behaviour by construction.
 * @param policies the policy list, typically from `definePolicies([...])`.
 * @param options role registry + procedure `ctx` (see {@link ExpectPolicyOptions}).
 */
export const expectPolicy = <Context = unknown>(policies: ReadonlyArray<Policy<Context>>, options: ExpectPolicyOptions<Context> = {}): PolicyAssertion => {
    const rolePermissions = indexRolePermissions(options.roles);
    const context = (options.ctx ?? {}) as Context;

    return {
        as: (identity) => {
            const auth = identity ?? {};
            const roles = auth.roles ?? [];

            const baseContext: PolicyContext<Context> = {
                auth: {
                    // The same role→permission resolution the middleware performs
                    // once per request.
                    can: resolveCan(roles, rolePermissions),
                    // eslint-disable-next-line unicorn/no-null -- PolicyContext.auth.identity is a public `… | null` type, mirroring the middleware
                    identity: auth.identity ?? null,
                    roles,
                    // eslint-disable-next-line unicorn/no-null -- PolicyContext.auth.userId is a public `null | string` type, mirroring the middleware
                    userId: auth.userId ?? null,
                },
                ctx: context,
            };

            const can = (op: PolicyOperation, table: string, row?: Record<string, unknown>, nextRow?: Record<string, unknown>): boolean => {
                const tablePolicies = policies.filter((policy) => policy.table === table);

                // Unguarded table — the middleware never wraps it, so every op passes.
                if (tablePolicies.length === 0) {
                    return true;
                }

                if (op === "read") {
                    // No read policy on a participating table → reads unrestricted
                    // (mirrors `readBase`'s `restricts: false`).
                    if (!tablePolicies.some((policy) => policy.on === "read")) {
                        return true;
                    }

                    const baseWhere: undefined | WhereInput = computeReadBaseWhere(tablePolicies, baseContext);

                    // `undefined` → unrestricted; the FALSE sentinel (`{ OR: [] }`)
                    // and any real predicate both fall through to `matchesWhere`,
                    // which a missing row can never satisfy.
                    return baseWhere === undefined || matchesWhere(row ?? {}, baseWhere);
                }

                return evaluateWrite(tablePolicies, op, { ...baseContext, row }, nextRow);
            };

            return {
                can,
                cannot: (op, table, row, nextRow) => !can(op, table, row, nextRow),
            };
        },
    };
};
