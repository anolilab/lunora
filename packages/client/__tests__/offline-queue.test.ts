import { describe, expect, test, vi } from "vitest";

import { OfflineQueue } from "../src/offline-queue.js";

describe("offlineQueue", () => {
    test("fIFO drain order", () => {
        const queue = new OfflineQueue();
        const order: string[] = [];

        for (const path of ["a", "b", "c"]) {
            queue.enqueue({
                functionPath: path,
                args: {},
                resolve: () => order.push(`done:${path}`),
                reject: () => order.push(`fail:${path}`),
            });
        }

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["a", "b", "c"]);
        expect(queue.size).toBe(0);
    });

    test("bounded by maxItems — oldest entry is rejected on overflow", () => {
        const queue = new OfflineQueue({ maxItems: 2 });
        const rejected = vi.fn();

        queue.enqueue({
            functionPath: "old",
            args: {},
            resolve: () => undefined,
            reject: rejected,
        });
        queue.enqueue({ functionPath: "mid", args: {}, resolve: () => undefined, reject: () => undefined });
        queue.enqueue({ functionPath: "new", args: {}, resolve: () => undefined, reject: () => undefined });

        expect(queue.size).toBe(2);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.code).toBe("OFFLINE_QUEUE_OVERFLOW");

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["mid", "new"]);
    });

    test("clear() rejects pending mutations with CLIENT_CLOSED and empties the queue", () => {
        const queue = new OfflineQueue();
        const rejected = vi.fn();

        queue.enqueue({ functionPath: "a", args: {}, resolve: () => undefined, reject: rejected });
        queue.clear();

        expect(queue.size).toBe(0);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.message).toBe("CLIENT_CLOSED");
        expect(error.code).toBe("CLIENT_CLOSED");
    });
});
