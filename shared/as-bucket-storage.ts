/**
 * Make any resolved storage capability bucket-aware so `ctx.storage.bucket(name)`
 * always resolves. A `createBucketStorage(...)` result already carries
 * `.bucket` / `.bucketName` and is returned as-is; a single `createStorage(...)`
 * (or the no-storage stub) gets `.bucket(name)` as the identity — single-bucket
 * apps address one binding under every name.
 *
 * Its `bucketName` tag is the storage's OWN name when it has one, and only
 * `"default"` when it does not. The tag is what `storageRules(...)` matches
 * `(bucket, operation)` rules against and what `assertRuleBucketsReachable`
 * checks, while `getSignedUrl` signs with the name the storage was built with —
 * stamping `"default"` over a `createStorage({ bucketName: "avatars" })` split
 * those two apart, so URLs were signed as `avatars` while an `avatars` rule was
 * rejected as unreachable and the storage was governed as `default`.
 *
 * Lives here rather than in `@lunora/server` because two packages need it and
 * neither may depend on the other: `@lunora/server` re-exports it as the runtime
 * counterpart `_generated/shard.ts` imports, and `@lunora/runtime` uses it to
 * build `ctx.storage` for an HTTP action from the worker's own R2 bindings.
 * Inlined into each `dist` by the bundler, so no dependency edge is created.
 *
 * The input is genuinely heterogeneous (a thunk result cast through `unknown`),
 * so the signature is `unknown → unknown`; callers cast the result.
 */
const asBucketStorage = (raw: unknown): unknown => {
    const candidate = (raw ?? {}) as { bucket?: unknown; bucketName?: unknown };

    if (typeof candidate.bucket === "function") {
        return candidate;
    }

    const own = candidate.bucketName;
    const bucketName = typeof own === "string" && own !== "" ? own : "default";
    const self: Record<string, unknown> = { ...(candidate as Record<string, unknown>), bucketName };

    self.bucket = () => self;

    return self;
};

export { asBucketStorage };
