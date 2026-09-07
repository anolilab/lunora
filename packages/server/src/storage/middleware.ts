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
 * An allowlist has one failure mode, and it has already fired once: a method the
 * ctx GROWS is silently absent under a guarded procedure, so a handler calling it
 * throws a bare `TypeError` on a method its own type promises.
 * `ctx.storage.deleteAfterCommit` — installed by `withDeferredDeletes` on every
 * dispatch that can host a mutation handler — was dropped exactly that way. It is
 * in {@link GUARDED_METHODS} now, gated as a `delete` AT ENQUEUE TIME (the queued
 * call replays `delete(key)` against the unwrapped facade after the transaction
 * commits, past every wrapper — so the enqueue is the only point a rule can see).
 * Anything added to `ctx.storage` from here on belongs in that table or in the
 * dropped list above, deliberately, in the change that adds it.
 *
 * **`ctx.db.system` is gated too.** `ctx.db.system.query("_storage")` and
 * `.get("_storage", key)` read the SAME R2 adapter `ctx.storage` does — codegen
 * builds the adapter once and shares it — so leaving that sibling alone made it an
 * ungated route to every object's key, size and `sha256` in the bucket, past a
 * `read` prefix rule that the source and the studio's access-rules view both read
 * as "this caller sees only their own objects". Bytes stayed gated; keys and
 * hashes did not. The enumeration is FILTERED (a listing that throws on the first
 * unreadable object is not a listing) and the by-key `get` is refused, matching
 * `getMetadata`/`head`.
 *
 * `list` rules therefore DO govern something: they scope `_storage` enumeration
 * through `ctx.db.system`. They still govern nothing at the `ctx.storage` layer,
 * which exposes no `list` (and the wrapper drops any).
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

    /**
     * The deferred-delete enqueue (`withDeferredDeletes`). SYNCHRONOUS and
     * `void`-returning, like `getUrl` — the wrapping loop returns the original's
     * value directly, so it stays sync.
     */
    deleteAfterCommit?: (key: string) => void;
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
    db?: unknown;
    storage?: unknown;
}

/**
 * The `ctx.db.system` surface this middleware gates — the two `_storage` reads
 * (`@lunora/shard-engine`'s `SystemDatabaseReader`), structurally mirrored so this
 * package takes no dependency on that one. `_scheduled_functions` passes through.
 */
interface SystemReaderLike {
    get?: (table: string, id: string) => Promise<Record<string, unknown> | null>;
    query?: (table: string) => { collect?: () => Promise<ReadonlyArray<Record<string, unknown>>> };
}

/** The two per-request rule predicates {@link wrapSystemReader} needs, passed in rather than closed over. */
interface SystemReaderGate {
    assertAllowed: (op: StorageOperation, key: string, bucketName: string) => void;
    isAllowed: (op: StorageOperation, key: string, bucketName: string) => boolean;
}

/**
 * Gate the `_storage` half of `ctx.db.system` against the SAME rules `gate`
 * closes over, in the same bucket scope as `ctx.storage`.
 *
 * Module-level, with the two per-request predicates passed in, so the wrapper's
 * own closures start at the top nesting level rather than four deep inside the
 * middleware.
 *
 * `ctx.db.system` is a sibling field on the same ctx backed by the same R2
 * adapter (codegen builds the adapter once and shares it), and neither `rls`
 * nor this middleware rewrote it — `rls`'s `isFacadeEntry` deliberately
 * excludes the system reader, and the engine's writer guard rates it
 * `"ungated"` because reserved tables are not user tables. That reasoning
 * holds for the per-table RLS model; it does not hold for a second policy
 * model written over exactly those rows' underlying objects.
 *
 * The enumeration is filtered rather than refused: a listing that throws on
 * the first object the caller cannot read is not a listing, and filtering is
 * how every other collection read under a policy behaves. Each object must
 * clear BOTH `list` (the operation the DSL has for exactly this) and `read`
 * (so a `read` prefix rule — which the source and the studio's access-rules
 * view both read as "only their own objects" — actually scopes it). Either
 * with no rules for the bucket is a no-op, so an ungoverned app is untouched.
 *
 * The by-key `get` throws, matching `getMetadata`/`head`, which project the
 * same metadata.
 */
const wrapSystemReader = (reader: SystemReaderLike, bucketName: string, gate: SystemReaderGate): SystemReaderLike => {
    const readable = (key: string): boolean => gate.isAllowed("list", key, bucketName) && gate.isAllowed("read", key, bucketName);

    const { get, query } = reader;
    const wrapped: SystemReaderLike = { ...reader };

    // The object key IS the `_storage` row id. Hoisted out of the `collect`
    // closure so the filter callback does not sit five function levels deep.
    const keepReadable = (rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] =>
        rows.filter((row) => typeof row["key"] === "string" && readable(row["key"]));

    if (typeof get === "function") {
        wrapped.get = async (table: string, id: string) => {
            if (table === "_storage") {
                gate.assertAllowed("read", id, bucketName);
            }

            return get(table, id);
        };
    }

    if (typeof query === "function") {
        wrapped.query = (table: string) => {
            const inner = query(table);
            const { collect } = inner;

            if (table !== "_storage" || typeof collect !== "function") {
                return inner;
            }

            return { ...inner, collect: async () => keepReadable(await collect()) };
        };
    }

    return wrapped;
};

/**
 * A rule governs a key when its prefix is absent (whole bucket) or the key sits
 * under it — matched on a PATH-SEGMENT boundary, never a raw `startsWith`.
 *
 * A bare `startsWith` makes `users/1` govern `users/10/avatar.png`: one user's
 * rule silently reaches every user whose id it happens to prefix. Which way that
 * misfires depends on the rule — an `allow` leaks a neighbour's objects, a
 * `deny` locks out a stranger — so both directions are wrong.
 *
 * A trailing slash on the prefix is cosmetic (`users/1` and `users/1/` scope the
 * same subtree), and an empty prefix is treated as absent so a whole-bucket rule
 * written `prefix: ""` keeps governing every key.
 */
const prefixMatches = (prefix: string | undefined, key: string): boolean => {
    if (prefix === undefined) {
        return true;
    }

    const scope = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

    return scope === "" || key === scope || key.startsWith(`${scope}/`);
};

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
    // The deferred-delete enqueue. Gated HERE rather than at the flush: the queue
    // replays `delete(key)` against the facade that owns it once the transaction
    // commits, which is past this wrapper and outside the request's policy scope,
    // so the enqueue is the only point a rule can still see the key.
    ["deleteAfterCommit", "delete"],
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
        const isAllowed = (op: StorageOperation, key: string, bucketName: string): boolean => {
            const applicable = rules.filter((rule) => rule.on === op && rule.bucket === bucketName);

            if (applicable.length === 0) {
                return true;
            }

            const context: StorageRuleContext<Context> = { auth: authContext, ctx, key };

            // `=== true` on every rule verdict: `when` is app code declared to answer
            // a boolean, and a truthy non-boolean (the claim rather than the decision)
            // must deny, never grant.
            return applicable.some((rule) => prefixMatches(rule.prefix, key) && rule.when(context) === true);
        };

        const assertAllowed = (op: StorageOperation, key: string, bucketName: string): void => {
            if (!isAllowed(op, key, bucketName)) {
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

        const extension: Record<string, unknown> = { storage: wrapStorage(storage) };
        const database = ctx.db as Record<string, unknown> | undefined;
        const system = database?.["system"] as SystemReaderLike | undefined;

        if (database !== undefined && system !== undefined && typeof system === "object") {
            // Spread, like `rls`'s wrapper: `ctx.db` is a literal of closures plus the
            // per-table facade entries and the RLS unwrap symbol, all own-enumerable,
            // so the copy keeps every one of them. `runMiddlewareChain` shallow-MERGES
            // the extension, so a `db` replaced here composes with `rls`/`mask` in
            // either order — each of those spreads whatever `ctx.db` it is handed and
            // passes `system` through untouched.
            extension["db"] = { ...database, system: wrapSystemReader(system, storage.bucketName ?? "default", { assertAllowed, isAllowed }) };
        }

        return next({ ctx: extension });
    };
};

// eslint-disable-next-line import/prefer-default-export -- mirrors `../rls/middleware`'s named `rls` export; the package index re-exports it by name
export { storageRules };
