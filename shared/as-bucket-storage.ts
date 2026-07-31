/**
 * Make any resolved storage capability bucket-aware so `ctx.storage.bucket(name)`
 * always resolves. A `createBucketStorage(...)` result already carries
 * `.bucket` / `.bucketName` and is returned as-is; a single `createStorage(...)`
 * (or the no-storage stub) is tagged as the `"default"` bucket, where
 * `.bucket(name)` is the identity — single-bucket apps address one binding under
 * every name.
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
    const candidate = (raw ?? {}) as { bucket?: unknown };

    if (typeof candidate.bucket === "function") {
        return candidate;
    }

    const self: Record<string, unknown> = { ...(candidate as Record<string, unknown>), bucketName: "default" };

    self.bucket = () => self;

    return self;
};

export { asBucketStorage };
