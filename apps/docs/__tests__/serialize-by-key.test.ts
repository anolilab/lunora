import { describe, expect, it } from "vitest";

import { serializeByKey } from "@/lib/serialize-by-key";

const deferred = () => {
    let resolve!: (value: number) => void;
    const promise = new Promise<number>((r) => {
        resolve = r;
    });

    return { promise, resolve };
};

/** Let the queued microtasks run. */
const tick = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe("serializeByKey", () => {
    it("forgets a key once its queue drains", async () => {
        expect.assertions(2);

        const queue = serializeByKey();

        // The map is keyed on caller identity on a public endpoint, so an entry
        // that outlives its work is one permanent allocation per caller.
        await Promise.all([queue.run("a", async () => 1), queue.run("b", async () => 2), queue.run("c", async () => 3)]);

        expect(queue.size()).toBe(0);

        await queue.run("a", async () => 1);

        expect(queue.size()).toBe(0);
    });

    it("forgets a key whose task rejected", async () => {
        expect.assertions(2);

        const queue = serializeByKey();

        await expect(queue.run("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

        expect(queue.size()).toBe(0);
    });

    it("runs one task at a time per key", async () => {
        expect.assertions(2);

        const queue = serializeByKey();
        const first = deferred();
        const order: string[] = [];

        const a = queue.run("k", async () => {
            order.push("a:start");

            const value = await first.promise;

            order.push("a:end");

            return value;
        });
        const b = queue.run("k", async () => {
            order.push("b:start");

            return 2;
        });

        // Tasks are chained off a promise, so they start a microtask later.
        await tick();

        // `b` must not begin while `a` is still in flight — the read-modify-write
        // it wraps is only safe if each task observes the previous one's write.
        expect(order).toStrictEqual(["a:start"]);

        first.resolve(1);
        await Promise.all([a, b]);

        expect(order).toStrictEqual(["a:start", "a:end", "b:start"]);
    });

    it("keeps a key alive while work is still queued behind the running task", async () => {
        expect.assertions(2);

        const queue = serializeByKey();
        const first = deferred();

        const a = queue.run("k", async () => first.promise);
        const b = queue.run("k", async () => 2);

        expect(queue.size()).toBe(1);

        first.resolve(1);
        await Promise.all([a, b]);

        expect(queue.size()).toBe(0);
    });

    it("does not let one task's rejection break the next caller's link", async () => {
        expect.assertions(2);

        const queue = serializeByKey();

        await expect(queue.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        await expect(queue.run("k", async () => 7)).resolves.toBe(7);
    });
});
