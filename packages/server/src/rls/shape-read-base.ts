/**
 * Resolve the RLS read base-where a `defineShape` must AND-compose with.
 *
 * A shape names a table + predicate and replicates the matching rows to a
 * client (the local-first sync engine). Unlike a `query`, a shape runs no
 * procedure, so the `.use(rls(...))` middleware never executes and its
 * membership reads would bypass every read policy on the table — leaking rows
 * the caller can't see. This module closes that hole: it collects the project's
 * read policies (hoisted onto each registered function by the procedure builder,
 * keyed by the {@link readRlsTag} the `rls()` middleware stamps) into a
 * table-indexed registry, then — at `resolveShape` time, under the socket's
 * verified identity — evaluates the table's read policies into a base-where and
 * AND-merges it with the shape's own predicate.
 *
 * Fail-closed parity with `@lunora/do`'s `guardWriter`: under a
 * `.rls("required")` schema a non-`.public()` table with NO read policy is
 * denied (the shape replicates nothing), never silently unrestricted.
 *
 * The evaluation mirrors the `rls()` middleware's request-time path exactly —
 * the same `computeReadBaseWhere` / `indexRolePermissions` / `permissionName`
 * primitives — so a shape's filter has zero semantic drift from an equivalent
 * `query` guarded by the same policies.
 */

import { computeReadBaseWhere, indexRolePermissions, permissionName } from "./middleware";
import { readRlsTag } from "./policy-tag";
import type { Policy, Role, WhereInput } from "./types";

/** A registered function that may carry policies hoisted from its `.use(rls(...))` chain. */
interface FunctionWithRls {
    readonly rls?: { readonly policies: ReadonlyArray<Policy>; readonly roles: ReadonlyArray<Role> };
}

/** Table-indexed read policies + the role→permission grants that back `auth.can(...)`. */
interface RlsReadRegistry {
    readonly byTable: ReadonlyMap<string, ReadonlyArray<Policy>>;
    readonly rolePermissions: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The trusted, server-resolved facts a shape's RLS evaluation runs under. */
interface ShapeReadWhereRequest {
    /** The shape ctx (the procedure context a policy `when` reads as `ctx`). */
    readonly ctx: unknown;
    /** Resolved identity claims (the socket's verified identity), or `null` when anonymous. */
    readonly identity: Record<string, unknown> | null;
    /** `true` when the schema is `.rls("required")` — gates the fail-closed branch. */
    readonly rlsRequired: boolean;
    /** Role labels the request carries (drives `auth.can(...)`). */
    readonly roles: ReadonlyArray<string>;
    /** The shape's own predicate (`where(ctx, args)`). */
    readonly shapeWhere: WhereInput;
    /** Logical table the shape replicates. */
    readonly table: string;
    /** `true` when the table is `.public()` (exempt from `.rls("required")` denial). */
    readonly tablePublic: boolean;
    /** Verified user id, or `null` when anonymous. */
    readonly userId: null | string;
}

/** Mutable accumulator threaded through {@link buildRlsReadRegistry}. */
interface RegistryAccumulator {
    readonly byTable: Map<string, Policy[]>;
    readonly roles: Role[];
    readonly seenByTable: Map<string, Set<Policy["when"]>>;
    readonly seenRoles: Set<string>;
}

/** Sentinel `WhereInput` compiling to a vacuously-false predicate (deny). Mirrors the middleware. */
const FALSE_PREDICATE: WhereInput = { OR: [] };

/** Fold one function's `read` policies + roles into the accumulator (deduped by `(table, when)` / role name). */
const collectFunctionRls = (accumulator: RegistryAccumulator, tag: FunctionWithRls["rls"]): void => {
    if (!tag) {
        return;
    }

    for (const policy of tag.policies) {
        if (policy.on !== "read") {
            continue;
        }

        const seen = accumulator.seenByTable.get(policy.table) ?? new Set<Policy["when"]>();

        if (seen.has(policy.when)) {
            continue;
        }

        seen.add(policy.when);
        accumulator.seenByTable.set(policy.table, seen);

        const list = accumulator.byTable.get(policy.table) ?? [];

        list.push(policy);
        accumulator.byTable.set(policy.table, list);
    }

    for (const role of tag.roles) {
        if (accumulator.seenRoles.has(role.name)) {
            continue;
        }

        accumulator.seenRoles.add(role.name);
        accumulator.roles.push(role);
    }
};

/** `true` for the vacuously-false sentinel (`{ OR: [] }`) — replicate nothing. */
const isFalsePredicate = (where: WhereInput): boolean => {
    const or = (where as { OR?: unknown }).OR;

    return Array.isArray(or) && or.length === 0 && Object.keys(where).length === 1;
};

/** AND-merge the injected base-where with the caller's predicate (mirrors the middleware's `mergeBaseWhere`). */
const andMerge = (injected: undefined | WhereInput, caller: WhereInput): WhereInput => {
    if (!injected || Object.keys(injected).length === 0) {
        return caller;
    }

    // A denied base-where short-circuits: the shape replicates nothing, and
    // wrapping it in `AND` would only obscure that for the shardability guard
    // and the row selector downstream.
    if (isFalsePredicate(injected)) {
        return injected;
    }

    if (Object.keys(caller).length === 0) {
        return injected;
    }

    return { AND: [injected, caller] };
};

/** Resolve the table's read base-where (or the fail-closed sentinel), or `undefined` when unrestricted. */
const resolveReadBaseWhere = (registry: RlsReadRegistry, request: ShapeReadWhereRequest): undefined | WhereInput => {
    const policies = registry.byTable.get(request.table);

    if (!policies || policies.length === 0) {
        // No read policy for this table. Under `.rls("required")` a non-public
        // table is denied (secure-by-default, matching `guardWriter`); otherwise
        // it is unrestricted.
        return request.rlsRequired && !request.tablePublic ? FALSE_PREDICATE : undefined;
    }

    const granted = new Set<string>();

    for (const roleName of request.roles) {
        for (const name of registry.rolePermissions.get(roleName) ?? []) {
            granted.add(name);
        }
    }

    return computeReadBaseWhere(policies, {
        auth: {
            can: (permission) => granted.has(permissionName(permission)),
            identity: request.identity,
            roles: request.roles,
            userId: request.userId,
        },
        ctx: request.ctx,
    });
};

/**
 * Build the read-policy registry from the registered functions (pass
 * `Object.values(LUNORA_FUNCTIONS)`). Only `on: "read"` policies are collected;
 * a `(table, when)` pair is de-duplicated so the same policy reused across
 * several procedures contributes once. Roles from every `rls(..., { roles })`
 * are unioned so `auth.can(...)` resolves the same as at request time.
 */
const buildRlsReadRegistry = (functions: Iterable<unknown>): RlsReadRegistry => {
    const accumulator: RegistryAccumulator = {
        byTable: new Map<string, Policy[]>(),
        roles: [],
        seenByTable: new Map<string, Set<Policy["when"]>>(),
        seenRoles: new Set<string>(),
    };

    for (const entry of functions) {
        const tag = (entry as FunctionWithRls | null)?.rls ?? readRlsTag(entry);

        collectFunctionRls(accumulator, tag);
    }

    return { byTable: accumulator.byTable, rolePermissions: indexRolePermissions(accumulator.roles) };
};

/**
 * Compute the effective `where` a shape replicates: the table's RLS read
 * base-where AND the shape's own predicate. Returns the shape predicate
 * unchanged for a table with no read policy (a `.public()` or non-RLS table),
 * and the FALSE sentinel (replicate nothing) when a `.rls("required")` schema
 * exposes a protected, policy-less table.
 */
const composeShapeReadWhere = (registry: RlsReadRegistry, request: ShapeReadWhereRequest): WhereInput =>
    andMerge(resolveReadBaseWhere(registry, request), request.shapeWhere);

export type { RlsReadRegistry, ShapeReadWhereRequest };
export { buildRlsReadRegistry, composeShapeReadWhere };
