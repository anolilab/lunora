import { describe, expect, it } from "vitest";

import createBucketStorage from "../src/bucket-storage";
import type { Storage } from "../src/types";

/** A minimal `Storage` double whose `getUrl` encodes which bucket served it. */
const fakeBucket = (label: string): Storage =>
    ({
        getUrl: (key: string) => `${label}://${key}`,
    }) as unknown as Storage;

describe("createBucketStorage", () => {
    it("throws when no buckets are supplied", () => {
        expect.assertions(1);

        expect(() => createBucketStorage({})).toThrow(/at least one bucket/);
    });

    it("targets the `default` key for the bare accessor", () => {
        expect.assertions(2);

        const storage = createBucketStorage({ avatars: fakeBucket("avatars"), default: fakeBucket("default") });

        expect(storage.bucketName).toBe("default");
        expect(storage.getUrl("a.png")).toBe("default://a.png");
    });

    it("honours an explicit default and switches buckets via bucket(name)", () => {
        expect.assertions(3);

        const storage = createBucketStorage({ avatars: fakeBucket("avatars"), files: fakeBucket("files") }, { default: "files" });

        expect(storage.bucketName).toBe("files");

        const avatars = storage.bucket("avatars");

        expect(avatars.bucketName).toBe("avatars");
        expect(avatars.getUrl("p.png")).toBe("avatars://p.png");
    });

    it("falls back to the first key when no default is given or present", () => {
        expect.assertions(1);

        const storage = createBucketStorage({ first: fakeBucket("first"), second: fakeBucket("second") });

        expect(storage.bucketName).toBe("first");
    });

    it("throws on an unknown bucket name", () => {
        expect.assertions(1);

        const storage = createBucketStorage({ default: fakeBucket("default") });

        expect(() => storage.bucket("nope")).toThrow(/no bucket registered for "nope"/);
    });
});
