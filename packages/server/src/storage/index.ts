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
 * accessor to `"media"`. Likewise a single-bucket app (`createStorage`) tags every
 * accessor `"default"`. Match the rule's `bucket` to the name the binding is
 * registered under in the app's `.storage({ bucket, buckets })` declaration.
 *
 * **A rule naming a bucket the request's storage cannot address throws** — it is
 * a configuration error, not a no-op. It has to be: such a rule governs nothing,
 * so the operation it was written to lock down stays wide open while the source
 * and the studio's access-rules view both read as if it were enforced. The check
 * runs per request in the middleware, against the accessor itself, because the
 * registered bucket names live in a runtime declaration. Do **not** validate
 * against the generated `StorageBucketName` union: it is seeded from
 * `v.storage()` columns *and from the rules themselves*, so it can never
 * disagree with a rule, and it is not the runtime bucket map either.
 */
export { defineStorageRule, defineStorageRules } from "./define";
export { storageRules } from "./middleware";
export type { DefineStorageRuleInput, StorageOperation, StorageRule, StorageRuleContext, StorageRuleDecision, StorageRulesOptions } from "./types";
