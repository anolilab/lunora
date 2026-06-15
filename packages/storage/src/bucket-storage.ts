import type { Storage } from "./types";

/**
 * A bucket-aware {@link Storage}: the methods target a default bucket, and
 * `bucket(name)` selects a different named bucket (declared via
 * `v.storage("name")`). `bucketName` is the bucket the current accessor targets
 * — the storage-rules middleware reads it to scope `(bucket, operation)` rules.
 */
interface BucketStorage extends Storage {
    /** Select a named bucket. Unknown names throw with the list of registered buckets. */
    bucket: (name: string) => BucketStorage;
    /** The bucket this accessor's operations target. */
    readonly bucketName: string;
}

/**
 * Compose several per-bucket {@link Storage} instances into one bucket-aware
 * accessor. The bare methods (`download` / `store` / …) target the default
 * bucket; `bucket(name)` switches to another. Each accessor is tagged with its
 * `bucketName` so `storageRules(...)` can enforce per-bucket.
 *
 * ```ts
 * storage: (env) => createBucketStorage({
 *     default: createStorage({ bucket: env.FILES }),
 *     avatars: createStorage({ bucket: env.AVATARS }),
 * }),
 * // → ctx.storage.download(key)             // default bucket
 * // → ctx.storage.bucket("avatars").store() // the avatars bucket
 * ```
 *
 * The bare accessor is tagged `"default"` — the canonical name a
 * `defineStorageRule({ bucket: "default" })` rule and the generated
 * `StorageBucketName` union both use — unless `options.default` names another
 * bucket (then the bare accessor takes that name). The binding it delegates to is
 * `options.default`, else the `"default"` key when present, else the first
 * registered bucket. Named buckets are reached with `bucket(name)`.
 */
const createBucketStorage = (buckets: Record<string, Storage>, options: { default?: string } = {}): BucketStorage => {
    const names = Object.keys(buckets);
    const [firstName] = names;

    if (firstName === undefined) {
        throw new Error("@lunora/storage: createBucketStorage requires at least one bucket");
    }

    if (options.default !== undefined && !buckets[options.default]) {
        throw new Error(`@lunora/storage: default bucket "${options.default}" is not in the bucket map (have: ${names.join(", ")})`);
    }

    // The bare `ctx.storage` is tagged `"default"` unless an explicit default
    // names another bucket, so a `{ bucket: "default" }` rule reliably guards it
    // and the tag stays consistent with `asBucketStorage` (single-bucket apps).
    const defaultTag = options.default ?? "default";
    const defaultBinding = buckets[defaultTag] ?? buckets[firstName];

    // Belt-and-suspenders + type narrowing: `buckets[firstName]` is runtime-present
    // (it's the first `Object.keys` entry, and the empty case already threw), but
    // strict index access types it `Storage | undefined`, so this both narrows
    // `defaultBinding` to `Storage` and guards the (unreachable) hole.
    if (defaultBinding === undefined) {
        throw new Error(`@lunora/storage: default bucket "${defaultTag}" is not in the bucket map (have: ${names.join(", ")})`);
    }

    const addressable = [...new Set([defaultTag, ...names])];

    // Resolve `name` to a fresh, immutably-tagged accessor. `defaultTag` maps to
    // the default binding; any other name to its registered bucket (unknown →
    // throw). Spreading the target's (closure-based, `this`-free) methods, then
    // layering the bucket identity + selector, keeps each accessor independent.
    const make = (name: string): BucketStorage => {
        const target = name === defaultTag ? defaultBinding : buckets[name];

        if (!target) {
            throw new Error(`@lunora/storage: no bucket registered for "${name}". Known buckets: ${addressable.join(", ")}`);
        }

        return { ...target, bucket: (next: string) => make(next), bucketName: name };
    };

    return make(defaultTag);
};

export default createBucketStorage;
export type { BucketStorage };
