import { LunoraError } from "@lunora/errors";

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
 *     default: createStorage({ bucket: env.FILES, bucketName: "default" }),
 *     avatars: createStorage({ bucket: env.AVATARS, bucketName: "avatars" }),
 * }),
 * // → ctx.storage.download(key)             // default bucket
 * // → ctx.storage.bucket("avatars").store() // the avatars bucket
 * ```
 *
 * The bare accessor is tagged with the name of the binding it actually
 * delegates to: `options.default` when given, else `"default"` when that key
 * exists (the canonical name a `defineStorageRule({ bucket: "default" })` rule
 * and the generated `StorageBucketName` union use), else the first registered
 * bucket. Tag and binding must agree or a `{ bucket: "avatars" }` rule would
 * gate `bucket("avatars").download()` and not the identical bare
 * `ctx.storage.download()` reaching the same R2 bucket. Named buckets are
 * reached with `bucket(name)`.
 */
export const createBucketStorage = (buckets: Record<string, Storage>, options: { default?: string } = {}): BucketStorage => {
    const names = Object.keys(buckets);
    const [firstName] = names;

    if (firstName === undefined) {
        throw new LunoraError("INTERNAL", "@lunora/storage: createBucketStorage requires at least one bucket");
    }

    if (options.default !== undefined && !Object.hasOwn(buckets, options.default)) {
        throw new LunoraError("INTERNAL", `@lunora/storage: default bucket "${options.default}" is not in the bucket map (have: ${names.join(", ")})`);
    }

    // The bare `ctx.storage` is tagged with the name of the bucket it delegates
    // to, never with `"default"` over some other binding: the tag is what
    // `storageRules` matches, so tagging `{ avatars }`'s only bucket `"default"`
    // would leave a `{ bucket: "avatars" }` rule gating `bucket("avatars")` and
    // not the bare accessor that reaches the very same R2 bucket.
    const defaultTag = options.default ?? (buckets.default ? "default" : firstName);
    const defaultBinding = buckets[defaultTag];

    // Belt-and-suspenders + type narrowing: `buckets[firstName]` is runtime-present
    // (it's the first `Object.keys` entry, and the empty case already threw), but
    // strict index access types it `Storage | undefined`, so this both narrows
    // `defaultBinding` to `Storage` and guards the (unreachable) hole.
    if (defaultBinding === undefined) {
        throw new LunoraError("INTERNAL", `@lunora/storage: default bucket "${defaultTag}" is not in the bucket map (have: ${names.join(", ")})`);
    }

    const addressable = [...new Set([defaultTag, ...names])];

    // Resolve `name` to a fresh, immutably-tagged accessor. `defaultTag` maps to
    // the default binding; any other name to its registered bucket (unknown →
    // throw). Spreading the target's (closure-based, `this`-free) methods, then
    // layering the bucket identity + selector, keeps each accessor independent.
    const make = (name: string): BucketStorage => {
        // Own-property check, not truthiness: a prototype key ("constructor",
        // "toString", "__proto__", …) resolves to an inherited Object.prototype
        // member on this plain map, passes the guard, and yields an accessor
        // that is an empty spread of a function — no `delete`/`download`, but a
        // `bucketName` tag `storageRules` would then match rules against.
        // Mirrors `@lunora/bindings`' vector and KV introspectors.
        const registered = Object.hasOwn(buckets, name) ? buckets[name] : undefined;
        const target = name === defaultTag ? defaultBinding : registered;

        if (!target) {
            throw new LunoraError("INTERNAL", `@lunora/storage: no bucket registered for "${name}". Known buckets: ${addressable.join(", ")}`);
        }

        return { ...target, bucket: (next: string) => make(next), bucketName: name };
    };

    return make(defaultTag);
};

export type { BucketStorage };
