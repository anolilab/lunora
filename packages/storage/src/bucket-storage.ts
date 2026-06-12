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
 * The default bucket is `options.default`, else the `"default"` key when
 * present, else the first registered bucket.
 */
const createBucketStorage = (buckets: Record<string, Storage>, options: { default?: string } = {}): BucketStorage => {
    const names = Object.keys(buckets);
    const [firstName] = names;

    if (firstName === undefined) {
        throw new Error("@cirrus/storage: createBucketStorage requires at least one bucket");
    }

    const defaultName = options.default ?? (buckets.default ? "default" : firstName);

    if (!buckets[defaultName]) {
        throw new Error(`@cirrus/storage: default bucket "${defaultName}" is not in the bucket map (have: ${names.join(", ")})`);
    }

    const make = (name: string): BucketStorage => {
        const target = buckets[name];

        if (!target) {
            throw new Error(`@cirrus/storage: no bucket registered for "${name}". Known buckets: ${names.join(", ")}`);
        }

        // Spread the target's (closure-based, `this`-free) methods, then layer on
        // the bucket identity + selector. A fresh object per `bucket(name)` call
        // is cheap and keeps each accessor immutably tagged.
        return { ...target, bucket: (next: string) => make(next), bucketName: name };
    };

    return make(defaultName);
};

export default createBucketStorage;
export type { BucketStorage };
