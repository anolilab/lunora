/**
 * Resolve the RLS read base-where a `defineShape` must AND-compose with.
 *
 * A shape names a table + predicate and replicates the matching rows to a
 * client (the local-first sync engine). Unlike a `query`, a shape runs no
 * procedure, so the `.use(rls(...))` middleware never executes and its
 * membership reads would bypass every read policy the shape is meant to honour.
 * This module closes that hole: it collects the read policies of the `rls()`
 * guards a declaration names (keyed by the {@link readRlsTags} the `rls()`
 * middleware stamps) into a table-indexed registry, then — at `resolveShape`
 * time, under the socket's verified identity — evaluates them into a base-where
 * and AND-merges it with the shape's own predicate.
 *
 * SCOPE. The registry is built from ONE declaration's guards
 * (`defineShape({ use })`), never from every registered function in the project.
 * A project-wide registry is a union, and `resolveReadBaseWhere` treats a group
 * that grants unrestricted access as unrestricting the whole table — so one
 * admin-only procedure carrying `rls([{ on: "read", when: () => true }])`
 * collapsed every tenant shape on that table to "no filter", for every
 * subscriber. It could not be otherwise: an `rls()` bundle is only half of a
 * procedure's authorization, the other half being the middlewares around it
 * (`requireAdmin`) that a shape cannot run. Request-time scope is per-procedure,
 * so a shape's has to be per-shape.
 *
 * Fail-closed parity with `@lunora/do`'s `guardWriter`: under a
 * `.rls("required")` schema a non-`.public()` table the shape declares no read
 * policy for is denied (the shape replicates nothing), never silently
 * unrestricted. Under an opt-in schema a shape that names no guard is filtered
 * by its own `where` alone — the same opt-in deal a query without
 * `.use(rls(...))` gets.
 *
 * Within that scope the evaluation mirrors the `rls()` middleware's
 * request-time path — the same `computeReadBaseWhere` / `indexRolePermissions` /
 * `permissionName` primitives — with ONE documented divergence: roles come from
 * the identity claim only, because no middleware runs to contribute
 * `ctx.auth.roles` (see the KNOWN DIVERGENCE note on `evaluateGroupBaseWhere`).
 */

import { computeReadBaseWhere, indexRolePermissions, readIdentityRoles, resolveCan } from "./middleware";
import type { RlsTag } from "./policy-tag";
import { readRlsTags } from "./policy-tag";
import { deny } from "./predicates";
import type { Policy, WhereInput } from "./types";

/** A registered function that may carry the rls() tags hoisted from its `.use(rls(...))` chain. */
interface FunctionWithRls {
    readonly rls?: { readonly tags: ReadonlyArray<RlsTag> };
}

/**
 * One `rls()` tag's read policies for a table, paired with the role→permission
 * grants of that SAME middleware. Keeping the role map per-group is what lets a
 * policy's `auth.can(...)` resolve against its own middleware's roles — never a
 * permission registered on a different `rls()` step.
 */
interface ScopedReadPolicies {
    readonly policies: ReadonlyArray<Policy>;
    readonly rolePermissions: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Table-indexed read-policy groups, each scoped to the roles of the rls() middleware that declared it. */
interface RlsReadRegistry {
    readonly byTable: ReadonlyMap<string, ReadonlyArray<ScopedReadPolicies>>;
}

/** The trusted, server-resolved facts a shape's RLS evaluation runs under. */
interface ShapeReadWhereRequest {
    /** The shape ctx (the procedure context a policy `when` reads as `ctx`). */
    readonly ctx: unknown;
    /** Resolved identity claims (the socket's verified identity), or `null` when anonymous. */
    readonly identity: Record<string, unknown> | null;
    /** `true` when the schema is `.rls("required")` — gates the fail-closed branch. */
    readonly rlsRequired: boolean;
    /** The shape's own predicate (`where(ctx, args)`). */
    readonly shapeWhere: WhereInput;
    /** Logical table the shape replicates. */
    readonly table: string;
    /** `true` when the table is `.public()` (exempt from `.rls("required")` denial). */
    readonly tablePublic: boolean;
    /** Verified user id, or `null` when anonymous. */
    readonly userId: null | string;
}

/** Sentinel `WhereInput` compiling to a vacuously-false predicate (deny). See `./predicates`. */
const FALSE_PREDICATE: WhereInput = deny();

/** Normalize a registered function (or a raw tagged middleware) to the list of rls() tags it carries. */
const readEntryTags = (entry: unknown): ReadonlyArray<RlsTag> => {
    const hoisted = (entry as FunctionWithRls | null)?.rls?.tags;

    if (hoisted) {
        return hoisted;
    }

    return readRlsTags(entry);
};

/**
 * Fold one rls() tag's `read` policies into the registry as a role-scoped group,
 * one entry per table the tag touches. `when` closures are de-duplicated within
 * the tag so a policy reused across its own steps contributes once; the tag's
 * roles are resolved into a per-group `auth.can(...)` map so evaluation matches
 * the request-time `rls()` path for the SAME middleware.
 */
const addTagToRegistry = (byTable: Map<string, ScopedReadPolicies[]>, tag: RlsTag): void => {
    const rolePermissions = indexRolePermissions(tag.roles);
    const seenWhenByTable = new Map<string, Set<Policy["when"]>>();
    const policiesByTable = new Map<string, Policy[]>();

    for (const policy of tag.policies) {
        if (policy.on !== "read") {
            continue;
        }

        const seen = seenWhenByTable.get(policy.table) ?? new Set<Policy["when"]>();

        if (seen.has(policy.when)) {
            continue;
        }

        seen.add(policy.when);
        seenWhenByTable.set(policy.table, seen);

        const list = policiesByTable.get(policy.table) ?? [];

        list.push(policy);
        policiesByTable.set(policy.table, list);
    }

    for (const [table, policies] of policiesByTable) {
        const groups = byTable.get(table) ?? [];

        groups.push({ policies, rolePermissions });
        byTable.set(table, groups);
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

/**
 * Evaluate one role-scoped policy group's read base-where under the request's
 * roles — restricted to the grants of the rls() middleware that declared it, so
 * a permission registered on a different middleware can never satisfy it.
 */
const evaluateGroupBaseWhere = (group: ScopedReadPolicies, request: ShapeReadWhereRequest): undefined | WhereInput => {
    // Roles come from the socket's verified identity claims, and ONLY from there.
    // The caller does not get to hand them in separately — a `roles` field on
    // this request would be a role set with no producer behind it, which is how
    // role-gated policies came to pass their tests while `auth.roles` was
    // permanently `[]` in production.
    //
    // KNOWN DIVERGENCE: the request path takes the union of that claim and any
    // `ctx.auth.roles` an upstream middleware contributed (see `AuthLike`). A
    // shape runs no procedure, so no middleware fires and there is nothing to
    // union — an app deriving roles in middleware rather than from claims has
    // those roles on queries but not on live shapes, and a role-gated policy can
    // resolve differently for the two. The dangerous direction is an inverted
    // test (`!auth.roles.includes("restricted")`): roles is `[]` here, the
    // restricting branch never fires, and rows replicate over a subscription
    // that the equivalent query withholds.
    //
    // The only close is to derive the roles ON THE IDENTITY, where this path can
    // see them — never to add a `roles` field to this request. That is what
    // `@lunora/cloudflare-access`'s `createAccessResolver({ roles })` does with
    // the verified Access `groups` claim, and what any custom `resolveIdentity`
    // gating policies on roles must do too.
    const roles = readIdentityRoles(request.identity);

    return computeReadBaseWhere(group.policies, {
        auth: {
            can: resolveCan(roles, group.rolePermissions),
            identity: request.identity,
            roles,
            userId: request.userId,
        },
        ctx: request.ctx,
    });
};

/** Resolve the table's read base-where (or the fail-closed sentinel), or `undefined` when unrestricted. */
const resolveReadBaseWhere = (registry: RlsReadRegistry, request: ShapeReadWhereRequest): undefined | WhereInput => {
    const groups = registry.byTable.get(request.table);

    if (!groups || groups.length === 0) {
        // No read policy for this table. Under `.rls("required")` a non-public
        // table is denied (secure-by-default, matching `guardWriter`); otherwise
        // it is unrestricted.
        return request.rlsRequired && !request.tablePublic ? FALSE_PREDICATE : undefined;
    }

    const predicates: WhereInput[] = [];

    // Each group carries one rls() middleware's read policies and its OWN
    // role→permission map; OR the grants across groups — the same broadening
    // semantics `computeReadBaseWhere` applies to policies within one middleware.
    for (const group of groups) {
        const base = evaluateGroupBaseWhere(group, request);

        // A group granting unrestricted access makes the whole table unrestricted.
        if (base === undefined) {
            return undefined;
        }

        // A group that denies (all its policies abstained/denied) can't broaden
        // access — another group may still grant, so skip it rather than fail.
        if (isFalsePredicate(base)) {
            continue;
        }

        predicates.push(base);
    }

    // Every group denied/abstained: fail closed (never reveal the whole table).
    if (predicates.length === 0) {
        return FALSE_PREDICATE;
    }

    return predicates.length === 1 ? predicates[0] : { OR: predicates };
};

/**
 * Build the read-policy registry for ONE consumer from the `rls()` guards it
 * declares — `defineShape({ use })` passes its own list, and `defineShape` calls
 * this once at declaration time. Accepts either the tagged middlewares
 * themselves or anything carrying hoisted `fn.rls.tags`.
 *
 * Only `on: "read"` policies are collected, grouped per `rls()` middleware so
 * each group keeps its own role→permission map (a `(table, when)` pair is
 * de-duplicated within a tag). The same tag listed twice (a shared
 * `const guard = rls(...)`) is folded once. Within a group this mirrors the
 * request-time `rls()` path: a policy's `auth.can(...)` resolves against the
 * roles of the middleware that declared it, never a union.
 *
 * Do NOT hand this every registered function in the project — see the SCOPE
 * paragraph in the module docblock for what that silently did to tenant shapes.
 */
const buildRlsReadRegistry = (guards: Iterable<unknown>): RlsReadRegistry => {
    const byTable = new Map<string, ScopedReadPolicies[]>();
    const seenTags = new Set<RlsTag>();

    for (const entry of guards) {
        for (const tag of readEntryTags(entry)) {
            if (seenTags.has(tag)) {
                continue;
            }

            seenTags.add(tag);
            addTagToRegistry(byTable, tag);
        }
    }

    return { byTable };
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
