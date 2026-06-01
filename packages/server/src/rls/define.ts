/**
 * Policy / role constructors.
 *
 * Both are passthrough today — the runtime work happens in {@link ./middleware}.
 * Keeping the constructors thin lets us add validation (e.g. duplicate
 * `(table, on)` pair detection in `definePolicies`) without breaking the
 * declarative call-sites.
 */
import type { DefinePolicyInput, Policy, Role } from "./types.js";

export const definePolicy = <Context = unknown>(input: DefinePolicyInput<Context>): Policy<Context> => {
    return { on: input.on, table: input.table, when: input.when };
};

/**
 * Collect a list of policies into the structure the `rls()` middleware
 * consumes. Multiple read policies on the same table OR together (any one
 * matching reveals the row); multiple write policies for the same `(table,
 * op)` AND together (every one must allow). The current implementation keeps
 * them in order and lets the middleware decide — see `./middleware`.
 */
export const definePolicies = <Context = unknown>(policies: ReadonlyArray<Policy<Context>>): ReadonlyArray<Policy<Context>> => policies;

export const defineRole = (name: string, options: Omit<Role, "name"> = {}): Role => {
    return { name, ...options };
};
