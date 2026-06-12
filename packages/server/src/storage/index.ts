/**
 * Public surface for Storage Access Rules — the object-storage analogue of
 * Row-Level Security (`../rls`).
 *
 * ```ts
 * import { defineStorageRule, defineStorageRules, storageRules } from "@cirrus/server";
 *
 * const ownAvatars = defineStorageRule&lt;MyCtx>({
 *     bucket: "avatars",
 *     on: "read",
 *     prefix: "user/",
 *     when: ({ auth, key }) => key.startsWith(`user/${auth.userId}/`),
 * });
 *
 * const rules = defineStorageRules([ownAvatars]);
 *
 * const builders = initCirrus.dataModel&lt;DataModel>().create();
 * const guardedAction = builders.action.use(storageRules(rules));
 * ```
 *
 * Opt-in scope is the load-bearing invariant, exactly as for RLS: rules apply
 * only to procedures whose builder chain includes `.use(storageRules(...))`. A
 * bare `action` sees an unwrapped `ctx.storage` and the rule list has no effect.
 *
 * Per operation the model is default-deny: declaring any `read` rule locks down
 * every read on the bucket — a read is allowed only when a rule whose `prefix`
 * matches the key returns `true` (rules OR together). Operations with no rules
 * stay open. The `Permission` / `Role` capability layer is shared with RLS
 * (`definePermission` / `defineRole`), so `({ auth }) => auth.can(...)` works the
 * same in a storage rule.
 */
export { defineStorageRule, defineStorageRules } from "./define";
export { storageRules } from "./middleware";
export type {
    DefineStorageRuleInput,
    Permission,
    Role,
    StorageOperation,
    StorageRule,
    StorageRuleContext,
    StorageRuleDecision,
    StorageRulesOptions,
} from "./types";
