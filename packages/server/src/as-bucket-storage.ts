/**
 * Make any `config.storage` result bucket-aware so `ctx.storage.bucket(name)`
 * always resolves. A `createBucketStorage(...)` result already carries
 * `.bucket` / `.bucketName` and is returned as-is; a single `createStorage(...)`
 * (or the no-storage stub) is tagged as the `"default"` bucket, where
 * `.bucket(name)` is the identity — single-bucket apps address one binding under
 * every name.
 *
 * This is the runtime counterpart the generated `_generated/shard.ts` imports to
 * wrap `ctx.storage`; it lives here (the single source) rather than being stamped
 * inline into every generated file, so the bucket-tagging behaviour has one home
 * alongside the storage ctx types. The input is genuinely heterogeneous (a thunk
 * result cast through `unknown`), so the signature is `unknown → unknown`; the
 * generated caller casts the result to its storage type.
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

export default asBucketStorage;
