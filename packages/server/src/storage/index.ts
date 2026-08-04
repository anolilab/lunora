/**
 * Public surface for Storage Access Rules — the object-storage analogue of
 * Row-Level Security (`../rls`).
 *
 * ```ts
 * import { defineStorageRule, defineStorageRules, storageRules } from "@lunora/server";
 *
 * const ownAvatars = defineStorageRule<MyCtx>({
 *     bucket: "avatars",
 *     on: "read",
 *     prefix: "user/",
 *     when: ({ auth, key }) => key.startsWith(`user/${auth.userId}/`),
 * });
 *
 * const rules = defineStorageRules([ownAvatars]);
 *
 * const builders = initLunora.dataModel<DataModel>().create();
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
 *
 * **Bucket scoping — a rule's `bucket` must match the accessor's `bucketName`.**
 * A rule only governs operations on its own bucket. The bare `ctx.storage` is the
 * `"default"` bucket (so `{ bucket: "default" }` guards it), UNLESS the worker
 * built `createBucketStorage(..., { default: "media" })`, which renames the bare
 * accessor to `"media"` — then a `{ bucket: "default" }` rule is inert. Likewise a
 * single-bucket app (`createStorage`) tags every accessor `"default"`, so a
 * `{ bucket: "other" }` rule never fires. Match the rule's `bucket` to the name
 * the binding is addressed under (the generated `StorageBucketName` union lists
 * them); a mismatched bucket name is a silent no-op, not an error.
 */
export { defineStorageRule, defineStorageRules } from "./define";
export { storageRules } from "./middleware";
export type { DefineStorageRuleInput, StorageOperation, StorageRule, StorageRuleContext, StorageRuleDecision, StorageRulesOptions } from "./types";
