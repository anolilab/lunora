/**
 * Public types for the Storage Access Rules DSL — the object-storage analogue
 * of Row-Level Security (`../rls`).
 *
 * A rule is a pure function: it reads the request context plus the key the
 * operation targets and returns `true` (allow), `false` (deny), or `undefined`
 * (opt this rule out). Rules never mutate state.
 *
 * The middleware (`storageRules(rules)`) installs into a builder via `.use()` —
 * rules only apply to procedures whose chain includes that middleware, so
 * storage authorization is opt-in per procedure, never global.
 *
 * The `Permission` / `Role` capability layer is shared verbatim with RLS so a
 * single role set backs both `ctx.db` and `ctx.storage` checks.
 */
import type { Permission, Role } from "../rls/types";

/**
 * Operations a storage rule can gate. `read` covers `download` / `getMetadata`
 * / `getSignedUrl` / `getUrl`; `write` covers `store` / `generateUploadUrl`;
 * `delete` is `delete`; `list` is a prefix listing (governed via the file
 * browser / admin path, not `ctx.storage` which has no `list`).
 */
export type StorageOperation = "delete" | "list" | "read" | "write";

/** A rule's decision. `true` allows, `false` denies, `undefined` opts this rule out. */
export type StorageRuleDecision = boolean | undefined;

/**
 * Context handed to a storage rule. `auth` mirrors RLS's `PolicyContext.auth`
 * (the per-request userId / roles / identity and the `can(permission)` helper),
 * so a rule reads `({ auth, key }) => key.startsWith(`user/${auth.userId}/`)`.
 * `key` is the object key the operation targets (for `list`, the listing
 * prefix). `ctx` is the full procedure context the middleware closed over.
 */
export interface StorageRuleContext<Context = unknown> {
    readonly auth: {
        readonly can: (permission: Permission | string) => boolean;
        readonly identity?: Record<string, unknown> | null;
        /** Role labels from the identity's `roles` claim (see `PolicyContext.auth.roles`). */
        readonly roles: ReadonlyArray<string>;
        readonly userId: null | string;
    };
    readonly ctx: Context;
    /** The object key the operation targets (the listing prefix for `list`). */
    readonly key: string;
}

/** A registered storage rule as stored in the rule table. */
export interface StorageRule<Context = unknown> {
    /**
     * Logical bucket the rule governs — matched against the accessor's bucket
     * (`ctx.storage.bucketName`, or the bucket selected via `ctx.storage.bucket(name)`).
     * A rule only applies to operations on its own bucket. The unnamed bucket is
     * `"default"`. Also surfaced in the studio's access-rules view.
     *
     * Must name a bucket the request's storage can address, or the middleware
     * throws `INTERNAL`: an unaddressable rule governs nothing, which leaves its
     * operation open rather than locked down. Typed `string` rather than the
     * generated `StorageBucketName` union deliberately — that union is not the
     * set of registered buckets (it is seeded partly from these very rules), so
     * narrowing to it would reject valid names and still admit typos. The
     * runtime check in `./middleware` is the one that has the real set.
     */
    readonly bucket: string;
    readonly on: StorageOperation;

    /**
     * Optional key-prefix scope; the rule only governs keys under it. Absent (or
     * empty) ⇒ the whole bucket.
     *
     * Matched on a **path-segment boundary**: `users/1` governs `users/1` and
     * `users/1/avatar.png`, but NOT `users/10/avatar.png`. A trailing slash is
     * cosmetic — `users/1` and `users/1/` scope the same subtree.
     */
    readonly prefix?: string;
    readonly when: (context: StorageRuleContext<Context>) => StorageRuleDecision;
}

/** Input accepted by `defineStorageRule`. The result is the same shape. */
export interface DefineStorageRuleInput<Context = unknown> {
    bucket: string;
    on: StorageOperation;
    prefix?: string;
    when: (context: StorageRuleContext<Context>) => StorageRuleDecision;
}

/**
 * Options for the `storageRules(rules, options)` middleware. `roles` registers
 * the role→permission grants that back `ctx.auth.can(...)`, exactly as RLS's
 * `RlsOptions.roles` does — fail-closed for unlisted roles.
 */
export interface StorageRulesOptions {
    readonly roles?: ReadonlyArray<Role>;
}

export type { Permission, Role } from "../rls/types";
