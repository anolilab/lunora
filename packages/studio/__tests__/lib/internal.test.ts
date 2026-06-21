import { describe, expect, it, vi } from "vitest";

import { fireAndForget } from "../../src/lib/internal";

describe("fireAndForget", () => {
    it("invokes onError with the rejection reason", async () => {
        expect.assertions(2);

        const reason = new Error("boom");
        const onError = vi.fn<(error: unknown) => void>();

        fireAndForget(Promise.reject(reason), onError);

        // Let the rejected promise's .catch microtask settle.
        await Promise.resolve();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(reason);
    });

    it("does not throw when a promise rejects and no sink is provided", async () => {
        expect.assertions(1);

        expect(() => {
            fireAndForget(Promise.reject(new Error("ignored")));
        }).not.toThrow();

        // Drain the swallowed rejection so it can't leak into other tests.
        await Promise.resolve();
    });

    it("does not call onError when the promise resolves", async () => {
        expect.assertions(1);

        const onError = vi.fn<(error: unknown) => void>();

        fireAndForget(Promise.resolve("ok"), onError);

        await Promise.resolve();

        expect(onError).not.toHaveBeenCalled();
    });
});
