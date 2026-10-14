import { describe, expect, it } from "vitest";

import type { DeferredDeleteFlushResult } from "../src/deferred-deletes";
import { beginDeferredDeletes, flushDeferredDeletes, withDeferredDeletes } from "../src/deferred-deletes";

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

        await flushDeferredDeletes({ storage });

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

        await flushDeferredDeletes({ storage });

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
        await flushDeferredDeletes({ storage });

        expect(bucketDeleted).toStrictEqual(["one.png"]);
    });
});

describe("flushDeferredDeletes", () => {
    it("drains, so a second flush is a no-op", async () => {
        expect.assertions(3);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("a.png");

        const first: DeferredDeleteFlushResult = await flushDeferredDeletes({ storage });
        const second = await flushDeferredDeletes({ storage });

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

        const outcome = await flushDeferredDeletes({ storage });

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

        await expect(flushDeferredDeletes({ storage: root })).resolves.toStrictEqual({ attempted: 0, failures: [] });
    });

    it("reports, rather than silently succeeds, when no storage is configured", async () => {
        expect.assertions(3);

        // The "no storage configured" stub. Every other method on it throws that
        // message loudly; this must not be the one storage call that answers a
        // clean success while doing nothing.
        const stub = { bucketName: "default" };
        const storage = withDeferredDeletes(stub) as Facade;

        storage.deleteAfterCommit("a.png");

        const outcome = await flushDeferredDeletes({ storage });

        expect(outcome.attempted).toBe(1);
        expect(outcome.failures).toHaveLength(1);
        expect(String(outcome.failures[0]?.error)).toContain("no storage configured");
    });

    it("logs every failure through ctx.log with its key", async () => {
        expect.assertions(2);

        const { root } = makeStorage();
        const failing = {
            ...root,
            delete: async (): Promise<void> => {
                throw new Error("r2 down");
            },
        };
        const storage = withDeferredDeletes(failing) as Facade;
        const warnings: { fields?: Record<string, unknown>; message: string }[] = [];

        storage.deleteAfterCommit("leaked.png");

        await flushDeferredDeletes({ log: { warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ fields, message }) }, storage });

        // A leaked object with no log line is a leak nobody can find.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.fields?.["key"]).toBe("leaked.png");
    });

    it("is a no-op on a context with no storage at all", async () => {
        expect.assertions(1);

        // Every dispatch calls this unconditionally, including ones on a project
        // that configured no storage binding.
        await expect(flushDeferredDeletes({})).resolves.toStrictEqual({ attempted: 0, failures: [] });
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

describe("beginDeferredDeletes", () => {
    it("drops the keys queued inside a window that rolled back", async () => {
        expect.assertions(2);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;

        storage.deleteAfterCommit("dispatch-own.png");

        const settle = beginDeferredDeletes({ storage });

        storage.deleteAfterCommit("rolled-back.png");
        settle(false);

        const outcome = await flushDeferredDeletes({ storage });

        // The transaction that queued it never committed, so the row it was to
        // clean up after is still there. Deleting the object anyway is the one
        // direction that cannot be undone — and it is what the shared per-dispatch
        // list did, because `ctx.runMutation` hands the caller's ctx to the callee
        // and the two sets of keys were indistinguishable.
        expect(deleted).toStrictEqual(["dispatch-own.png"]);
        expect(outcome.attempted).toBe(1);
    });

    it("makes the keys flushable when the window commits", async () => {
        expect.assertions(1);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;
        const settle = beginDeferredDeletes({ storage });

        storage.deleteAfterCommit("committed.png");
        settle(true);

        await flushDeferredDeletes({ storage });

        expect(deleted).toStrictEqual(["committed.png"]);
    });

    it("hands a nested window's keys to the enclosing one rather than to the flush", async () => {
        expect.assertions(2);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;
        const outer = beginDeferredDeletes({ storage });
        const inner = beginDeferredDeletes({ storage });

        storage.deleteAfterCommit("nested.png");
        inner(true);

        // SQLite-in-DO has no savepoints: the nested dispatch rides the enclosing
        // span, so its keys are not safe to delete until THAT span commits.
        await flushDeferredDeletes({ storage });

        expect(deleted).toStrictEqual([]);

        outer(true);
        await flushDeferredDeletes({ storage });

        expect(deleted).toStrictEqual(["nested.png"]);
    });

    it("loses a nested window's keys when the enclosing one rolls back", async () => {
        expect.assertions(1);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;
        const outer = beginDeferredDeletes({ storage });
        const inner = beginDeferredDeletes({ storage });

        storage.deleteAfterCommit("nested.png");
        inner(true);
        outer(false);

        await flushDeferredDeletes({ storage });

        expect(deleted).toStrictEqual([]);
    });

    it("keeps a key queued after a sibling window has already rolled back", async () => {
        expect.assertions(1);

        const { deleted, root } = makeStorage();
        const storage = withDeferredDeletes(root) as Facade;
        const first = beginDeferredDeletes({ storage });

        first(false);

        // An action can leave a `ctx.runMutation` un-awaited, so windows settle in
        // whatever order their transactions resolve. A settled window must not stay
        // the innermost one — that would swallow every later key into a list nothing
        // drains.
        storage.deleteAfterCommit("after.png");

        await flushDeferredDeletes({ storage });

        expect(deleted).toStrictEqual(["after.png"]);
    });

    it("is an inert settle on a storage facade that was never wrapped", () => {
        expect.assertions(1);

        // A query ctx's storage is unwrapped, and the dispatch opens the window
        // unconditionally.
        const { root } = makeStorage();

        expect(() => {
            beginDeferredDeletes({ storage: root })(false);
        }).not.toThrow();
    });
});
