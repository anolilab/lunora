/**
 * Tests for the storage-rules DSL + middleware — the object-storage analogue of
 * `rls.test.ts`. A handwritten fake `ctx.storage` captures every call; the
 * middleware wraps it and enforces the rules before delegating.
 */
import { describe, expect, it } from "vitest";

import type { Middleware, StorageRule } from "../src/index";
import { defineStorageRule, defineStorageRules, initLunora, LunoraError, storageRules } from "../src/index";

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface FakeStorage {
    calls: { key: string; method: string }[];
    storage: {
        bucketName: string;
        delete: (key: string) => Promise<void>;
        download: (key: string) => Promise<undefined>;
        getUrl: (key: string) => string;
        store: (key: string, body: unknown) => Promise<{ etag: string; key: string }>;
    };
}

const createFakeStorage = (): FakeStorage => {
    const calls: { key: string; method: string }[] = [];

    return {
        calls,
        storage: {
            bucketName: "avatars",
            delete: async (key: string): Promise<void> => {
                calls.push({ key, method: "delete" });
            },
            download: async (key: string): Promise<undefined> => {
                calls.push({ key, method: "download" });

                return undefined;
            },
            getUrl: (key: string): string => {
                calls.push({ key, method: "getUrl" });

                return `https://cdn.example/${key}`;
            },
            store: async (key: string): Promise<{ etag: string; key: string }> => {
                calls.push({ key, method: "store" });

                return { etag: "e", key };
            },
        },
    };
};

interface TestContext {
    auth: { roles: string[]; userId: null | string };
    storage: FakeStorage["storage"];
}

const makeContext = (fake: FakeStorage, userId: null | string, roles: string[] = []): TestContext => {
    return { auth: { roles, userId }, storage: fake.storage };
};

const rulesForTest = <Context>(rules: ReadonlyArray<StorageRule<Context>>): Middleware<any, any> =>
    (storageRules as unknown as (r: ReadonlyArray<StorageRule<Context>>) => Middleware<any, any>)(rules);

describe("defineStorageRules — duplicate detection", () => {
    it("throws on the same (bucket, on, prefix) with the same decision function", () => {
        expect.assertions(1);

        const when = (): boolean => true;
        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", prefix: "user/", when });

        expect(() => defineStorageRules([rule, rule])).toThrow(/duplicate rule/);
    });

    it("allows distinct rules for the same (bucket, on)", () => {
        expect.assertions(1);

        const a = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", prefix: "user/", when: () => true });
        const b = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", prefix: "public/", when: () => true });

        expect(defineStorageRules([a, b])).toHaveLength(2);
    });
});

describe("storageRules — read path", () => {
    it("allows a read whose key matches an allowing rule's prefix", async () => {
        expect.assertions(1);

        const rule = defineStorageRule<TestContext>({
            bucket: "avatars",
            on: "read",
            when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`),
        });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.download("user/u1/a.png"));

        await handler.handler(makeContext(fake, "u1"), {});

        expect(fake.calls).toEqual([{ key: "user/u1/a.png", method: "download" }]);
    });

    it("denies a read for a key another user owns", async () => {
        expect.assertions(2);

        const rule = defineStorageRule<TestContext>({
            bucket: "avatars",
            on: "read",
            when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`),
        });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.download("user/u2/secret.png"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).rejects.toThrow(LunoraError);
        expect(fake.calls).toEqual([]);
    });

    it("leaves an operation with no rules unrestricted (opt-in)", async () => {
        expect.assertions(1);

        // Only a `read` rule is declared; `delete` is ungoverned and passes through.
        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", when: () => false });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.delete("anything"));

        await handler.handler(makeContext(fake, "u1"), {});

        expect(fake.calls).toEqual([{ key: "anything", method: "delete" }]);
    });
});

describe("storageRules — prefix scoping + default-deny", () => {
    it("locks down every read on the bucket once any read rule exists (key outside all prefixes is denied)", async () => {
        expect.assertions(1);

        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", prefix: "user/", when: () => true });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.getUrl("public/logo.png"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).rejects.toThrow(/denied by access rule/);
    });

    it("applies OR across multiple rules — any allowing rule grants the op", async () => {
        expect.assertions(1);

        const own = defineStorageRule<TestContext>({
            bucket: "avatars",
            on: "read",
            prefix: "user/",
            when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`),
        });
        const shared = defineStorageRule<TestContext>({ bucket: "avatars", on: "read", prefix: "public/", when: () => true });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([own, shared])).action(async ({ ctx }) => ctx.storage.getUrl("public/logo.png"));

        const url = await handler.handler(makeContext(fake, "u1"), {});

        expect(url).toBe("https://cdn.example/public/logo.png");
    });
});

describe("storageRules — write/delete path", () => {
    it("denies a write that no rule allows", async () => {
        expect.assertions(1);

        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "write", when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`) });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.store("user/u2/x.png", new ArrayBuffer(1)));

        await expect(handler.handler(makeContext(fake, "u1"), {})).rejects.toThrow(/storage write/);
    });

    it("allows a delete the rule grants", async () => {
        expect.assertions(1);

        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "delete", when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`) });

        const fake = createFakeStorage();
        const handler = lunora.action.use(rulesForTest<TestContext>([rule])).action(async ({ ctx }) => ctx.storage.delete("user/u1/old.png"));

        await handler.handler(makeContext(fake, "u1"), {});

        expect(fake.calls).toEqual([{ key: "user/u1/old.png", method: "delete" }]);
    });
});

/** A bucket-tagged fake storage: `default` + `avatars`, each recording calls, with `bucket(name)` switching. */
interface BucketedFakeStorage {
    calls: { bucket: string; key: string; method: string }[];
    storage: BucketedFakeAccessor;
}

interface BucketedFakeAccessor {
    bucket: (name: string) => BucketedFakeAccessor;
    bucketName: string;
    download: (key: string) => Promise<undefined>;
    store: (key: string, body: unknown) => Promise<{ etag: string; key: string }>;
}

const createBucketedFakeStorage = (): BucketedFakeStorage => {
    const calls: { bucket: string; key: string; method: string }[] = [];

    const make = (bucketName: string): BucketedFakeAccessor => {
        return {
            bucket: (name: string) => make(name),
            bucketName,
            download: async (key: string): Promise<undefined> => {
                calls.push({ bucket: bucketName, key, method: "download" });

                return undefined;
            },
            store: async (key: string): Promise<{ etag: string; key: string }> => {
                calls.push({ bucket: bucketName, key, method: "store" });

                return { etag: "e", key };
            },
        };
    };

    return { calls, storage: make("default") };
};

interface BucketedContext {
    auth: { roles: string[]; userId: null | string };
    storage: BucketedFakeAccessor;
}

const makeBucketedContext = (fake: BucketedFakeStorage, userId: null | string): BucketedContext => {
    return { auth: { roles: [], userId }, storage: fake.storage };
};

describe("storageRules — bucket scoping", () => {
    it("enforces a rule only on its own bucket, leaving sibling buckets open", async () => {
        expect.assertions(2);

        // A read rule on `avatars` only. The `default` bucket has no rule → open.
        const rule = defineStorageRule<BucketedContext>({
            bucket: "avatars",
            on: "read",
            when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`),
        });

        const fake = createBucketedFakeStorage();
        const handler = lunora.action.use(rulesForTest<BucketedContext>([rule])).action(async ({ ctx }) => {
            // default bucket is ungoverned → allowed even though the key wouldn't match the avatars rule
            await ctx.storage.download("anything/x.png");
            // avatars bucket is governed → this owner-scoped key is allowed
            await ctx.storage.bucket("avatars").download("user/u1/a.png");
        });

        await handler.handler(makeBucketedContext(fake, "u1"), {});

        expect(fake.calls).toContainEqual({ bucket: "default", key: "anything/x.png", method: "download" });
        expect(fake.calls).toContainEqual({ bucket: "avatars", key: "user/u1/a.png", method: "download" });
    });

    it("denies a read on the targeted bucket when its rule rejects the key", async () => {
        expect.assertions(1);

        const rule = defineStorageRule<BucketedContext>({
            bucket: "avatars",
            on: "read",
            when: ({ auth, key }) => key.startsWith(`user/${auth.userId ?? ""}/`),
        });

        const fake = createBucketedFakeStorage();
        const handler = lunora.action
            .use(rulesForTest<BucketedContext>([rule]))
            .action(async ({ ctx }) => ctx.storage.bucket("avatars").download("user/u2/secret.png"));

        await expect(handler.handler(makeBucketedContext(fake, "u1"), {})).rejects.toThrow(/bucket "avatars"/);
    });
});

describe("storageRules — allowlist (privileged methods dropped)", () => {
    it("drops upload / list / getPresignedUrl / multipart so they can't evade the rules", async () => {
        expect.assertions(5);

        // A write rule that denies everything; were `upload` passed through it would bypass it.
        const rule = defineStorageRule<TestContext>({ bucket: "avatars", on: "write", when: () => false });

        // A backing storage carrying the privileged R2 escape hatches alongside `store`.
        const backing = {
            bucketName: "avatars",
            createMultipartUpload: () => {
                return {};
            },
            getPresignedUrl: async () => "https://r2.example/presigned",
            list: async () => {
                return { objects: [] };
            },
            resumeMultipartUpload: () => {
                return {};
            },
            store: async (key: string) => {
                return { etag: "e", key };
            },
            upload: async (key: string) => {
                return { etag: "e", key };
            },
        };

        let exposed: Record<string, unknown> = {};
        const context = { auth: { roles: [], userId: "u1" }, storage: backing };
        const handler = lunora.action.use(rulesForTest([rule])).action(async ({ ctx }) => {
            exposed = ctx.storage;
        });

        await handler.handler(context, {});

        // The gated alias survives (and would enforce); the raw siblings are gone.
        expect(typeof exposed.store).toBe("function");
        expect(exposed.upload).toBeUndefined();
        expect(exposed.list).toBeUndefined();
        expect(exposed.getPresignedUrl).toBeUndefined();
        expect(exposed.createMultipartUpload).toBeUndefined();
    });
});
