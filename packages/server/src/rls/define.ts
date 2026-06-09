/**
 * Policy / role constructors.
 *
 * `definePolicy` / `defineRole` are thin shape constructors; `definePolicies`
 * additionally validates the set (duplicate detection). The runtime work happens
 * in {@link ./middleware}.
 */
import type { DefinePolicyInput, Permission, Policy, Role } from "./types";

export const definePolicy = <Context = unknown>(input: DefinePolicyInput<Context>): Policy<Context> => {
    return { on: input.on, table: input.table, when: input.when };
};

/**
 * Declare a named permission a policy can check with `ctx.auth.can(...)`. Grant
 * it to a role through `defineRole`'s `permissions`, register those roles with
 * the middleware via `rls(policies, { roles })`, then check it in a policy with
 * `when: ({ auth }) => auth.can(permission)`. See the `./index` JSDoc for a
 * worked example.
 */
export const definePermission = (name: string, options: Omit<Permission, "name"> = {}): Permission => {
    return { name, ...options };
};

/**
 * Collect a list of policies into the structure the `rls()` middleware
 * consumes. Multiple read policies on the same table OR together (any one
 * matching reveals the row); multiple write policies for the same `(table,
 * op)` AND together (every one must allow). The middleware keeps them in order
 * and decides — see `./middleware`.
 *
 * Validates against an **accidentally duplicated policy** — the same
 * `(table, on)` registered with the *same* decision function (a copy-paste, or
 * the same policy object spread in twice). Because multiple DISTINCT policies
 * per `(table, on)` are intentional, the check keys on the `when` reference too:
 * only a reference-identical `when` for the same `(table, on)` is a real
 * duplicate. Throws at module load so the misconfiguration surfaces immediately
 * rather than as a silently double-evaluated predicate at request time.
 */
export const definePolicies = <Context = unknown>(policies: ReadonlyArray<Policy<Context>>): ReadonlyArray<Policy<Context>> => {
    const seenWhenByKey = new Map<string, Set<Policy<Context>["when"]>>();

    for (const policy of policies) {
        // JSON-encoded composite so a table name can never collide with a
        // separate `(table, on)` pair — a missed duplicate would silently
        // double-evaluate a policy predicate, so the key is collision-proof.
        const key = JSON.stringify([policy.table, policy.on]);
        const whens = seenWhenByKey.get(key) ?? new Set<Policy<Context>["when"]>();

        if (whens.has(policy.when)) {
            throw new Error(
                `definePolicies: duplicate policy for (table "${policy.table}", on "${policy.on}") — the same decision function is registered more than once. ` +
                    "Multiple distinct policies per (table, on) are allowed (reads OR, writes AND); remove the duplicate.",
            );
        }

        whens.add(policy.when);
        seenWhenByKey.set(key, whens);
    }

    return policies;
};

export const defineRole = (name: string, options: Omit<Role, "name"> = {}): Role => {
    return { name, ...options };
};
