/**
 * `storageRules(rules)` — the procedure-builder middleware that activates
 * Storage Access Rules for the downstream handler. The object-storage analogue
 * of `rls(policies)` (`../rls/middleware`).
 *
 * What it does, at runtime:
 *
 * 1. Resolves the request identity/roles once (like `rls`), then wraps
 * `ctx.storage`. Each guarded method (`download` / `getMetadata` / `getUrl` →
 * `read`; `store` / `generateUploadUrl` → `write`; `delete` → `delete`) checks
 * the key it targets against the rules for that operation before delegating to
 * the underlying storage. `getSignedUrl` is gated by the requested HTTP method:
 * `{ method: "PUT" }` mints an upload URL and is checked as `write`, otherwise
 * `read` — so a signed PUT URL can't bypass the bucket's write rules.
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
import { LunoraError } from "../error";
import type { AuthLike } from "../rls/middleware";
import { indexRolePermissions, resolvePolicyAuth } from "../rls/middleware";
import type { StorageOperation, StorageRule, StorageRuleContext, StorageRulesOptions } from "./types";

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
    auth?: AuthLike;
    storage?: unknown;
}

/** A rule governs a key when its prefix is absent (whole bucket) or the key sits under it. */
const prefixMatches = (prefix: string | undefined, key: string): boolean => prefix === undefined || key.startsWith(prefix);

/**
 * Resolve the operation a guarded call must satisfy. A static {@link StorageOperation}
 * fixes the op for the whole method; a function derives it per call from the
 * arguments — used for `getSignedUrl`, whose op depends on the requested HTTP
 * method (see below).
 */
type OperationResolver = ((args: ReadonlyArray<unknown>) => StorageOperation) | StorageOperation;

/**
 * `getSignedUrl(key, { method })` mints either a download (GET, a `read`
 * capability) or an upload (PUT, a `write` capability — it's the basis of the
 * `generateUploadUrl` alias). A static `read` classification would let a caller
 * mint a PUT/upload URL while only the bucket's `read` rules were consulted,
 * bypassing every `write` rule. Derive the op from the method argument so a PUT
 * URL is gated as a `write`. The default (no `method`, or any non-PUT) is `read`.
 */
const resolveSignedUrlOperation = (args: ReadonlyArray<unknown>): StorageOperation => {
    const options = args[1];
    const method = typeof options === "object" && options !== null ? (options as { method?: unknown }).method : undefined;

    return typeof method === "string" && method.toUpperCase() === "PUT" ? "write" : "read";
};

/**
 * The gated `ctx.storage` surface — each method paired with the operation a rule
 * must allow. This is the *only* surface the wrapper re-exposes; every other
 * method on the backing object (`upload`, `createMultipartUpload`,
 * `resumeMultipartUpload`, `getPresignedUrl`, `list`) is dropped so it can't
 * bypass enforcement. `list` has no entry because `ctx.storage` exposes none.
 *
 * `getSignedUrl` is gated by a per-call resolver (not a static op) because a
 * `{ method: "PUT" }` mints a write capability — see {@link resolveSignedUrlOperation}.
 */
const GUARDED_METHODS: ReadonlyArray<[keyof WrappableStorage, OperationResolver]> = [
    ["delete", "delete"],
    ["download", "read"],
    ["generateUploadUrl", "write"],
    ["getMetadata", "read"],
    ["getSignedUrl", resolveSignedUrlOperation],
    ["getUrl", "read"],
    ["store", "write"],
];

const storageRules = <Context extends StorageContextIn = StorageContextIn>(
    rules: ReadonlyArray<StorageRule<Context>>,
    options: StorageRulesOptions = {},
): Middleware<Context, Context> => {
    const rolePermissions = indexRolePermissions(options.roles);

    return async ({ ctx, next }) => {
        const authContext: StorageRuleContext<Context>["auth"] = await resolvePolicyAuth(ctx.auth ?? {}, rolePermissions);

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
                throw new LunoraError("FORBIDDEN", `storage ${op} on "${key}" in bucket "${bucketName}" denied by access rule`);
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
                        // Every guarded method takes the object key as its first arg.
                        // Coerce defensively so a malformed (keyless) call fails as a
                        // clean `FORBIDDEN`/no-match rather than `undefined.startsWith`.
                        const key = typeof args[0] === "string" ? args[0] : "";
                        // A resolver derives the op from the call (e.g. `getSignedUrl`
                        // → `write` for a PUT URL); a static op fixes it for the method.
                        const operation = typeof op === "function" ? op(args) : op;

                        assertAllowed(operation, key, bucketName);

                        return (original as (...callArgs: unknown[]) => unknown)(...args);
                    };
                }
            }

            const { bucket } = storage;

            if (typeof bucket === "function") {
                wrapped.bucket = (name: string): WrappableStorage => wrapStorage(bucket(name));
            }

            return wrapped;
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
