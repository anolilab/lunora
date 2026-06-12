/**
 * `storageRules(rules)` — the procedure-builder middleware that activates
 * Storage Access Rules for the downstream handler. The object-storage analogue
 * of `rls(policies)` (`../rls/middleware`).
 *
 * What it does, at runtime:
 *
 * 1. Resolves the request identity/roles once (like `rls`), then wraps
 * `ctx.storage`. Each guarded method (`download` / `getMetadata` /
 * `getSignedUrl` / `getUrl` → `read`; `store` / `generateUploadUrl` → `write`;
 * `delete` → `delete`) checks the key it targets against the rules for that
 * operation before delegating to the underlying storage.
 *
 * 2. **Per-op default-deny**: if ANY rule governs an operation, that operation
 * is locked down — it is allowed only when a rule whose `prefix` matches the
 * key returns `true` (rules OR together; each grants a slice of the keyspace).
 * An operation with no rules at all passes through untouched (opt-in, exactly
 * like a table with no RLS policy).
 *
 * 3. **Opt-in scope**: rules apply only inside procedures whose builder chain
 * includes this middleware. A procedure without `.use(storageRules(...))` sees
 * the unwrapped `ctx.storage`.
 *
 * The wrapper is an allowlist, not a passthrough: it re-exposes only the gated
 * surface and drops every privileged sibling on the backing object (`upload`,
 * `createMultipartUpload`, `resumeMultipartUpload`, `getPresignedUrl`, `list`),
 * so none of them can be invoked under a guarded procedure to evade the rules.
 *
 * `list` rules are metadata-only: `ctx.storage` exposes no `list` (and the
 * wrapper drops any), so a `list` rule is surfaced in the studio's access-rules
 * view for documentation but governs nothing at the `ctx.storage` layer.
 */
import type { Middleware } from "../builder/types";
import { CirrusError } from "../error";
import type { Permission, Role, StorageOperation, StorageRule, StorageRuleContext, StorageRulesOptions } from "./types";

/** The minimal `ctx.auth` shape the middleware reads — a structural subset that the full AuthState satisfies. Tolerant of older auth states (mirrors RLS's `AuthLike`). */
type StorageAuthLike = {
    getIdentity?: () => Promise<Record<string, unknown> | null>;
    roles?: ReadonlyArray<string>;
    userId?: null | string;
};

/** The wrappable subset of `ctx.storage`. Methods absent on a read-only storage are simply not wrapped. */
interface WrappableStorage {
    /** Select a named bucket; the returned accessor is wrapped + enforced too. */
    bucket?: (name: string) => WrappableStorage;
    /** The bucket this accessor targets — scopes which `(bucket, op)` rules apply. */
    bucketName?: string;
    delete?: (key: string) => Promise<void>;
    download?: (key: string) => Promise<unknown>;
    generateUploadUrl?: (key: string, options?: unknown) => Promise<string>;
    getMetadata?: (key: string) => Promise<unknown>;
    getSignedUrl?: (key: string, options?: unknown) => Promise<string>;
    getUrl?: (key: string) => string;
    store?: (key: string, body: unknown, options?: unknown) => Promise<unknown>;
}

interface StorageContextIn {
    auth?: StorageAuthLike;
    storage?: unknown;
}

const permissionName = (permission: Permission | string): string => (typeof permission === "string" ? permission : permission.name);

/** Map each role to the set of permission names it grants, for the `can(...)` lookup. */
const indexRolePermissions = (roles: ReadonlyArray<Role> = []): Map<string, Set<string>> => {
    const byRole = new Map<string, Set<string>>();

    for (const role of roles) {
        const granted = new Set<string>();

        for (const permission of role.permissions ?? []) {
            granted.add(permissionName(permission));
        }

        byRole.set(role.name, granted);
    }

    return byRole;
};

/** A rule governs a key when its prefix is absent (whole bucket) or the key sits under it. */
const prefixMatches = (prefix: string | undefined, key: string): boolean => prefix === undefined || key.startsWith(prefix);

/**
 * The gated `ctx.storage` surface — each method paired with the operation a rule
 * must allow. This is the *only* surface the wrapper re-exposes; every other
 * method on the backing object (`upload`, `createMultipartUpload`,
 * `resumeMultipartUpload`, `getPresignedUrl`, `list`) is dropped so it can't
 * bypass enforcement. `list` has no entry because `ctx.storage` exposes none.
 */
const GUARDED_METHODS: ReadonlyArray<[keyof WrappableStorage, StorageOperation]> = [
    ["delete", "delete"],
    ["download", "read"],
    ["generateUploadUrl", "write"],
    ["getMetadata", "read"],
    ["getSignedUrl", "read"],
    ["getUrl", "read"],
    ["store", "write"],
];

const storageRules = <Context extends StorageContextIn = StorageContextIn>(
    rules: ReadonlyArray<StorageRule<Context>>,
    options: StorageRulesOptions = {},
): Middleware<Context, Context> => {
    const rolePermissions = indexRolePermissions(options.roles);

    return async ({ ctx, next }) => {
        const auth: StorageAuthLike = ctx.auth ?? {};
        // eslint-disable-next-line unicorn/no-null -- StorageRuleContext.auth.identity carries `null` for the anonymous/no-resolver case
        const identity = (await auth.getIdentity?.()) ?? null;
        const roles = auth.roles ?? [];

        const granted = new Set<string>();

        for (const roleName of roles) {
            for (const name of rolePermissions.get(roleName) ?? []) {
                granted.add(name);
            }
        }

        const authContext: StorageRuleContext<Context>["auth"] = {
            can: (permission) => granted.has(permissionName(permission)),
            identity,
            roles,
            // eslint-disable-next-line unicorn/no-null -- StorageRuleContext.auth.userId is a public `null | string` type
            userId: auth.userId ?? null,
        };

        /**
         * Throw `FORBIDDEN` unless no rule governs `(op, bucketName)` or a matching
         * rule allows the key. Rules are scoped to the accessor's bucket — a rule for
         * a different bucket never applies. An operation with no rule for the bucket
         * stays open (opt-in, like a table with no RLS policy).
         */
        const assertAllowed = (op: StorageOperation, key: string, bucketName: string): void => {
            const applicable = rules.filter((rule) => rule.on === op && rule.bucket === bucketName);

            if (applicable.length === 0) {
                return;
            }

            const context: StorageRuleContext<Context> = { auth: authContext, ctx, key };
            const allowed = applicable.some((rule) => prefixMatches(rule.prefix, key) && rule.when(context) === true);

            if (!allowed) {
                throw new CirrusError("FORBIDDEN", `storage ${op} on "${key}" in bucket "${bucketName}" denied by access rule`);
            }
        };

        /**
         * Rebuild `ctx.storage` as an ALLOWLIST of the gated surface, enforcing each
         * method against the accessor's bucket. Only {@link GUARDED_METHODS} (plus the
         * `bucket(name)` selector) are re-exposed — privileged siblings on the backing
         * object (`upload`, `createMultipartUpload`, `resumeMultipartUpload`,
         * `getPresignedUrl`, `list`) are dropped, never passed through, so they can't
         * evade the rules (e.g. `upload` writing outside `write`, or a presigned URL
         * hitting R2 directly). `bucket(name)` is re-wrapped so a switched bucket is
         * enforced too. An untagged accessor is treated as the `"default"` bucket.
         */
        const wrapStorage = (storage: WrappableStorage): WrappableStorage => {
            const bucketName = storage.bucketName ?? "default";
            const wrapped: Record<string, unknown> = { bucketName };

            for (const [method, op] of GUARDED_METHODS) {
                const original = storage[method];

                if (typeof original === "function") {
                    wrapped[method] = (...args: unknown[]): unknown => {
                        assertAllowed(op, args[0] as string, bucketName);

                        return (original as (...callArgs: unknown[]) => unknown)(...args);
                    };
                }
            }

            const { bucket } = storage;

            if (typeof bucket === "function") {
                wrapped.bucket = (name: string): WrappableStorage => wrapStorage(bucket(name));
            }

            return wrapped as WrappableStorage;
        };

        const storage = ctx.storage as undefined | WrappableStorage;

        if (storage === undefined) {
            return next();
        }

        return next({ ctx: { storage: wrapStorage(storage) } });
    };
};

// eslint-disable-next-line import/prefer-default-export -- mirrors `../rls/middleware`'s named `rls` export; the package index re-exports it by name
export { storageRules };
