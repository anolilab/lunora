import { describe, expect, it } from "vitest";

import type { DeferredDeleteFlushResult } from "../src/deferred-deletes";
import { flushDeferredDeletes, withDeferredDeletes } from "../src/deferred-deletes";

/** The shape `asBucketStorage` hands over: a bucket-aware facade with a real `delete`. */
const makeStorage = () => {
    const deleted: string[] = [];
    const bucketDeleted: string[] = [];

    const named = {
        bucketName: "avatars",
        delete: async (key: string): Promise<void> => {
            bucketDeleted.push(key);
        },
    };

    const root = {
        bucket: (name: string) => (name === "avatars" ? named : root),
        bucketName: "default",
        delete: async (key: string): Promise<void> => {
            deleted.push(key);
        },
        download: async (key: string): Promise<string> => `body:${key}`,
    };

    return { bucketDeleted, deleted, root };
};

type Facade = {
    bucket: (name: string) => Facade;
    bucketName: string;
    deleteAfterCommit: (key: string) => void;
    download: (key: string) => Promise<string>;
};

describe("withDeferredDeletes", () => {
    it("queues rather than deleting", async () => {
        expect.assertions(2);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("a.png");
        storage.deleteAfterCommit("b.png");

        // Nothing has been attempted — that is the whole point of the deferral.
        expect(deleted).toStrictEqual([]);

        await flushDeferredDeletes(storage);

        expect(deleted).toStrictEqual(["a.png", "b.png"]);
    });

    it("preserves the underlying read surface", async () => {
        expect.assertions(2);

        const { root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        expect(storage.bucketName).toBe("default");
        await expect(storage.download("x")).resolves.toBe("body:x");
    });

    it("flushes a bucket-scoped delete against that bucket", async () => {
        expect.assertions(2);

        const { bucketDeleted, deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.bucket("avatars").deleteAfterCommit("me.png");
        storage.deleteAfterCommit("top.png");

        await flushDeferredDeletes(storage);

        // The sub-facade shares the queue, but each key is deleted through the
        // bucket it was queued against — not all through the default one.
        expect(bucketDeleted).toStrictEqual(["me.png"]);
        expect(deleted).toStrictEqual(["top.png"]);
    });

    it("flushes deletes queued through a sub-facade when the root is flushed", async () => {
        expect.assertions(1);

        const { bucketDeleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;
        const avatars = storage.bucket("avatars");

        avatars.deleteAfterCommit("one.png");

        // The dispatch only ever holds `ctx.storage`; a delete queued on a bucket
        // it handed out must still be reachable from there.
        await flushDeferredDeletes(storage);

        expect(bucketDeleted).toStrictEqual(["one.png"]);
    });
});

describe("flushDeferredDeletes", () => {
    it("drains, so a second flush is a no-op", async () => {
        expect.assertions(3);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("a.png");

        const first: DeferredDeleteFlushResult = await flushDeferredDeletes(storage);
        const second = await flushDeferredDeletes(storage);

        expect(first.attempted).toBe(1);
        expect(second.attempted).toBe(0);
        expect(deleted).toStrictEqual(["a.png"]);
    });

    it("reports a failure instead of throwing, and still deletes the rest", async () => {
        expect.assertions(4);

        const deleted: string[] = [];
        const root = {
            bucket: () => root,
            bucketName: "default",
            delete: async (key: string): Promise<void> => {
                if (key === "boom.png") {
                    throw new Error("r2 unavailable");
                }

                deleted.push(key);
            },
        };
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("boom.png");
        storage.deleteAfterCommit("fine.png");

        const outcome = await flushDeferredDeletes(storage);

        // A cleanup failure must never surface as a failed mutation — the write
        // already committed. It leaks an object, and says which one.
        expect(outcome.attempted).toBe(2);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]?.key).toBe("boom.png");
        expect(deleted).toStrictEqual(["fine.png"]);
    });

    it("is a no-op on a storage facade that was never wrapped", async () => {
        expect.assertions(1);

        // A query/action `ctx.storage` is not wrapped, so the dispatch must be able
        // to call this unconditionally without probing first.
        const { root } = makeStorage();

        await expect(flushDeferredDeletes(root)).resolves.toStrictEqual({ attempted: 0, failures: [] });
    });

    it("tolerates a facade with no delete at all", async () => {
        expect.assertions(1);

        // The "no storage configured" stub: `deleteAfterCommit` must not blow up
        // the dispatch that follows a mutation on a project without a bucket.
        const stub = { bucketName: "default" };
        const storage = withDeferredDeletes(stub) as Facade;

        storage.deleteAfterCommit("a.png");

        await expect(flushDeferredDeletes(storage)).resolves.toStrictEqual({ attempted: 1, failures: [] });
    });

    it("does not delete when the caller never flushes", () => {
        expect.assertions(1);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("rolled-back.png");

        // Stands in for a rolled-back mutation: the dispatch throws before reaching
        // the flush, the context is discarded, and the object must survive.
        expect(deleted).toStrictEqual([]);
    });
});
