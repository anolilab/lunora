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
 * `list` rules are metadata-only: `ctx.storage` exposes no `list`, so a `list`
 * rule is surfaced in the studio's access-rules view but not enforced here.
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

const storageRules = <Context extends StorageContextIn = StorageContextIn>(
    rules: ReadonlyArray<StorageRule<Context>>,
    options: StorageRulesOptions = {},
): Middleware<Context, Context> => {
    const rolePermissions = indexRolePermissions(options.roles);
    // Which operations are governed at all — an op with no rule stays unrestricted.
    const governed = new Set<StorageOperation>(rules.map((rule) => rule.on));

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

        /** Throw `FORBIDDEN` unless the op is unguarded or a matching rule allows the key. */
        const assertAllowed = (op: StorageOperation, key: string): void => {
            if (!governed.has(op)) {
                return;
            }

            const context: StorageRuleContext<Context> = { auth: authContext, ctx, key };
            const allowed = rules.some((rule) => rule.on === op && prefixMatches(rule.prefix, key) && rule.when(context) === true);

            if (!allowed) {
                throw new CirrusError("FORBIDDEN", `storage ${op} on "${key}" denied by access rule`);
            }
        };

        const storage = ctx.storage as undefined | WrappableStorage;

        if (storage === undefined) {
            return next();
        }

        // Spread the original so untouched methods (and read-only storages
        // lacking write methods) pass through; override only the ones present.
        const wrapped: WrappableStorage = { ...storage };

        if (storage.download !== undefined) {
            wrapped.download = (key) => {
                assertAllowed("read", key);

                return storage.download?.(key) as Promise<unknown>;
            };
        }

        if (storage.getMetadata !== undefined) {
            wrapped.getMetadata = (key) => {
                assertAllowed("read", key);

                return storage.getMetadata?.(key) as Promise<unknown>;
            };
        }

        if (storage.getSignedUrl !== undefined) {
            wrapped.getSignedUrl = (key, signOptions) => {
                assertAllowed("read", key);

                return storage.getSignedUrl?.(key, signOptions) as Promise<string>;
            };
        }

        if (storage.getUrl !== undefined) {
            wrapped.getUrl = (key) => {
                assertAllowed("read", key);

                return storage.getUrl?.(key) as string;
            };
        }

        if (storage.store !== undefined) {
            wrapped.store = (key, body, storeOptions) => {
                assertAllowed("write", key);

                return storage.store?.(key, body, storeOptions) as Promise<unknown>;
            };
        }

        if (storage.generateUploadUrl !== undefined) {
            wrapped.generateUploadUrl = (key, uploadOptions) => {
                assertAllowed("write", key);

                return storage.generateUploadUrl?.(key, uploadOptions) as Promise<string>;
            };
        }

        if (storage.delete !== undefined) {
            wrapped.delete = (key) => {
                assertAllowed("delete", key);

                return storage.delete?.(key) as Promise<void>;
            };
        }

        return next({ ctx: { storage: wrapped } });
    };
};

// eslint-disable-next-line import/prefer-default-export -- mirrors `../rls/middleware`'s named `rls` export; the package index re-exports it by name
export { storageRules };
