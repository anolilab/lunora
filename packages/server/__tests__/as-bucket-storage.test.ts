import { describe, expect, it } from "vitest";

import asBucketStorage from "../src/as-bucket-storage";

/**
 * `asBucketStorage` is the runtime helper the generated `_generated/shard.ts`
 * wraps `ctx.storage` with so `ctx.storage.bucket(name)` always resolves. A
 * multi-bucket result (already carrying `.bucket`) is returned untouched; a
 * single-bucket result (or the no-storage stub) is tagged `"default"` and given
 * an identity `bucket()`. The `bucketName` it stamps is security-relevant: the
 * `storageRules()` middleware scopes every rule by it, so a regression here
 * would silently make `{ bucket: "default" }` rules inert.
 */
describe("asBucketStorage", () => {
    it("returns a bucket-aware result unchanged (multi-bucket storage)", () => {
        expect.assertions(2);

        const multi = {
            bucket: (name: string) => {
                return { bucketName: name };
            },
            bucketName: "media",
        };

        const result = asBucketStorage(multi) as typeof multi;

        // Same reference — not re-wrapped.
        expect(result).toBe(multi);
        expect(result.bucket("avatars")).toStrictEqual({ bucketName: "avatars" });
    });

    it("tags a single-bucket result as the default bucket with an identity bucket()", () => {
        expect.assertions(3);

        const download = (key: string): string => `body:${key}`;
        const single = { download };

        const result = asBucketStorage(single) as { bucket: (name: string) => unknown; bucketName: string; download: (key: string) => string };

        expect(result.bucketName).toBe("default");
        // Original methods are preserved on the tagged result.
        expect(result.download("k")).toBe("body:k");
        // `bucket(name)` is the identity — single-bucket apps address one binding under every name.
        expect(result.bucket("anything")).toBe(result);
    });

    it("keeps a single-bucket storage's OWN name instead of stamping default over it", () => {
        expect.assertions(2);

        // `createStorage({ bucket: env.AVATARS, bucketName: "avatars" })` signs
        // URLs with "avatars". Re-tagging it "default" split the name the HMAC
        // canonical uses from the one `storageRules` matches on, so an
        // `{ bucket: "avatars" }` rule was rejected as unreachable while the
        // storage was governed by `{ bucket: "default" }` rules instead.
        const single = { bucketName: "avatars", download: (key: string): string => `body:${key}` };

        const result = asBucketStorage(single) as { bucket: (name: string) => unknown; bucketName: string };

        expect(result.bucketName).toBe("avatars");
        expect(result.bucket("anything")).toBe(result);
    });

    it("tolerates a nullish input by tagging an empty default bucket", () => {
        expect.assertions(2);

        const result = asBucketStorage(undefined) as { bucket: (name: string) => unknown; bucketName: string };

        expect(result.bucketName).toBe("default");
        expect(result.bucket("x")).toBe(result);
    });

    it("does not mutate the original single-bucket object (returns a copy)", () => {
        expect.assertions(2);

        const single: Record<string, unknown> = { store: () => undefined };

        const result = asBucketStorage(single) as Record<string, unknown>;

        // The tag is added to the copy, not the source.
        expect(single["bucketName"]).toBeUndefined();
        expect(result["bucketName"]).toBe("default");
    });
});
