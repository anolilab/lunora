import { describe, expect, it } from "vitest";

import { createBucketStorage } from "../src/bucket-storage";
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

    it("tags the bare accessor 'default' (delegating to the first binding) when no default is designated", () => {
        expect.assertions(3);

        const storage = createBucketStorage({ first: fakeBucket("first"), second: fakeBucket("second") });

        // Bare accessor is named "default" — the name rules + the union steer to —
        // even though it delegates to the first binding.
        expect(storage.bucketName).toBe("default");
        expect(storage.getUrl("a")).toBe("first://a");
        // The named buckets remain individually addressable.
        expect(storage.bucket("second").getUrl("b")).toBe("second://b");
    });

    it("throws on an unknown bucket name", () => {
        expect.assertions(1);

        const storage = createBucketStorage({ default: fakeBucket("default") });

        expect(() => storage.bucket("nope")).toThrow(/no bucket registered for "nope"/);
    });
});
