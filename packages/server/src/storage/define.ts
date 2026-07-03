/**
 * Storage-rule constructors.
 *
 * `defineStorageRule` is a thin shape constructor; `defineStorageRules`
 * additionally validates the set (duplicate detection). The runtime work
 * happens in {@link ./middleware}. Permissions/roles are declared with RLS's
 * `definePermission` / `defineRole` (re-exported from `../rls`) — the capability
 * layer is shared.
 */
import { LunoraError } from "@lunora/errors";

import type { DefineStorageRuleInput, StorageRule } from "./types";

export const defineStorageRule = <Context = unknown>(input: DefineStorageRuleInput<Context>): StorageRule<Context> => {
    return { bucket: input.bucket, on: input.on, prefix: input.prefix, when: input.when };
};

/**
 * Collect a list of storage rules into the structure the `storageRules()`
 * middleware consumes. Multiple rules for the same `(bucket, on)` OR together —
 * any one allowing grants the operation (each rule grants a slice of the
 * keyspace).
 *
 * Validates against an **accidentally duplicated rule** — the same
 * `(bucket, on, prefix)` registered with the *same* decision function (a
 * copy-paste, or the same rule object spread in twice). Because multiple
 * DISTINCT rules per `(bucket, on)` are intentional, the check keys on the
 * `when` reference too. Throws at module load so the misconfiguration surfaces
 * immediately rather than as a silently double-evaluated predicate.
 */
export const defineStorageRules = <Context = unknown>(rules: ReadonlyArray<StorageRule<Context>>): ReadonlyArray<StorageRule<Context>> => {
    const seenWhenByKey = new Map<string, Set<StorageRule<Context>["when"]>>();

    for (const rule of rules) {
        // `JSON.stringify` renders an `undefined` array element as `null`, so an
        // absent prefix keys stably without us writing a `null` literal.
        const key = JSON.stringify([rule.bucket, rule.on, rule.prefix]);
        const whens = seenWhenByKey.get(key) ?? new Set<StorageRule<Context>["when"]>();

        if (whens.has(rule.when)) {
            throw new LunoraError(
                "INTERNAL",
                `defineStorageRules: duplicate rule for (bucket "${rule.bucket}", on "${rule.on}"${rule.prefix === undefined ? "" : `, prefix "${rule.prefix}"`}) — ` +
                    "the same decision function is registered more than once. Multiple distinct rules per (bucket, on) are allowed (they OR); remove the duplicate.",
            );
        }

        whens.add(rule.when);
        seenWhenByKey.set(key, whens);
    }

    return rules;
};
