/**
 * `storageRules(rules)` — the procedure-builder middleware that activates
 * Storage Access Rules for the downstream handler. The object-storage analogue
 * of `rls(policies)` (`../rls/middleware`).
 *
 * What it does, at runtime:
 *
 * 1. Resolves the request identity/roles once (like `rls`), then wraps
 * `ctx.storage`. Each guarded method (`download` / `getMetadata` / `head` /
 * `getUrl` → `read`; `store` / `generateUploadUrl` → `write`; `delete` →
 * `delete`) checks
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
 * That opt-in only holds when "this operation has no rules" means the author
 * chose to leave it open. A rule naming a bucket the request's storage cannot
 * address is not a rule that doesn't fire — it is a rule that governs nothing,
 * and it leaves its intended operation wide open while reading as enforced in
 * source and in the studio's access-rules view. So the bucket of every rule is
 * checked for reachability before any wrapping happens — see
 * {@link assertRuleBucketsReachable}.
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
import { LunoraError } from "@lunora/errors";

import type { Middleware } from "../builder/types";
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

    /**
     * The one SYNCHRONOUS member of the guarded surface (every sibling returns
     * a Promise). The wrapping loop must keep returning its value directly —
     * making the wrapper `async` (or `await`ing the original) would silently
     * turn `ctx.storage.getUrl` into a Promise for guarded procedures only.
     * A test pins the sync return; if `getUrl` ever goes async upstream,
     * delete that pin and this note in the same change.
     */
    getUrl?: (key: string) => string;
    head?: (key: string) => Promise<unknown>;
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
    // The body-free sibling of `getMetadata` (it is what `getMetadata` projects),
    // so it reads the same bytes' metadata and must be gated identically —
    // otherwise it is an ungated route to everything `getMetadata`'s `read` rules
    // were written to fence off.
    ["head", "read"],
    ["store", "write"],
];

/**
 * Does `storage.bucket(name)` actually resolve to the bucket `name`?
 *
 * The ground truth, and the only reliable one. `createBucketStorage` returns an
 * accessor tagged with the requested name and throws for an unregistered one;
 * `asBucketStorage` — which every generated `ctx.storage` passes through — gives
 * a single-bucket app a selector that is the IDENTITY, returning the same
 * `"default"`-tagged accessor whatever it is handed. So "did it throw?" is not
 * the test (the identity selector never throws) and "does a selector exist?" is
 * not either (one always does). Whether the returned accessor is tagged with the
 * name asked for is the test, and it separates all three shapes.
 *
 * A custom storage that echoes any name back is simply not checked — that
 * direction only ever misses a bad rule, never rejects a good one.
 */
const selectsBucket = (bucket: (name: string) => WrappableStorage, name: string): boolean => {
    try {
        return bucket(name).bucketName === name;
    } catch {
        // An unregistered name — `createBucketStorage` throws with the known set.
        return false;
    }
};

/**
 * Throw unless every bucket named by a rule is one this request's storage can
 * actually address. A rule for an unaddressable bucket can never fire, so the
 * per-op default-deny it was written to engage never engages and the operation
 * it meant to lock down stays fully open — silently, because a mismatched name
 * is indistinguishable from a rule for a sibling bucket. The reported shape is a
 * single-bucket `createStorage` app (every accessor tagged `"default"`) whose
 * rule says `{ bucket: "uploads" }`: it compiles, the studio lists it, and every
 * user can read every other user's object.
 *
 * The addressable set is only knowable here, at runtime: the buckets a worker
 * registers come from its `.storage({ bucket, buckets })` declaration, which is
 * a runtime object. The generated `StorageBucketName` union is NOT that set (it
 * is seeded from `v.storage()` columns and from the rules themselves), so it
 * cannot be the check — see the bucket-union builder in `@lunora/codegen`'s
 * `emit.ts`, whose docblock spells out why.
 */
const assertRuleBucketsReachable = (storage: WrappableStorage, ruleBuckets: Iterable<string>): void => {
    const bucketName = storage.bucketName ?? "default";
    const { bucket } = storage;

    for (const name of new Set(ruleBuckets)) {
        if (name === bucketName || (typeof bucket === "function" && selectsBucket(bucket, name))) {
            continue;
        }

        throw new LunoraError(
            "INTERNAL",
            `storageRules: rule for bucket "${name}" governs nothing — this request's storage cannot address that bucket ` +
                `(the accessor is "${bucketName}", and selecting "${name}" does not reach a bucket of that name). ` +
                "A rule on an unaddressable bucket leaves the operation it was written to gate wide open. " +
                "Match the rule's `bucket` to the name the binding is registered under in `.storage({ bucket, buckets })`.",
        );
    }
};

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
         *
         * The empty-`applicable` fallthrough is only sound because every rule bucket
         * was already proven addressable ({@link assertRuleBucketsReachable}): reaching
         * it now means the author left this `(bucket, op)` ungoverned, not that a rule
         * meant for it was misnamed into inertness.
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

        assertRuleBucketsReachable(
            storage,
            rules.map((rule) => rule.bucket),
        );

        return next({ ctx: { storage: wrapStorage(storage) } });
    };
};

// eslint-disable-next-line import/prefer-default-export -- mirrors `../rls/middleware`'s named `rls` export; the package index re-exports it by name
export { storageRules };
