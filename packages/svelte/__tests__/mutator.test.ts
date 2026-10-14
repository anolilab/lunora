import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { MutatorTransaction } from "../src/mutator";
import { mutator } from "../src/mutator";

/** A controllable bound-mutator handle: returns a transaction whose persist promise we resolve/reject by hand. */
const deferredHandle = () => {
    const calls: { reject: (error: unknown) => void; resolve: () => void }[] = [];
    const handle = (_args: { text: string }): MutatorTransaction => {
        let settle: () => void = () => undefined;
        let fail: (error: unknown) => void = () => undefined;
        const promise = new Promise<unknown>((resolve, reject) => {
            settle = () => {
                resolve(undefined);
            };
            fail = reject;
        });

        calls.push({ reject: fail, resolve: settle });

        return { isPersisted: { promise } };
    };

    return { calls, handle };
};

describe("mutator handle", () => {
    it("flips pending while the transaction persists and clears it on success", async () => {
        const { calls, handle } = deferredHandle();
        const handleStore = mutator(handle);

        expect(get(handleStore.pending)).toBe(false);

        const settled = handleStore.mutate({ text: "hi" });

        expect(get(handleStore.pending)).toBe(true);

        calls[0]?.resolve();
        await settled;

        expect(get(handleStore.pending)).toBe(false);
        expect(get(handleStore.isError)).toBe(false);
        expect(get(handleStore.error)).toBeUndefined();
    });

    it("captures the error, rejects mutate, and clears it on reset", async () => {
        const { calls, handle } = deferredHandle();
        const handleStore = mutator(handle);

        let rejected: unknown;
        const settled = handleStore.mutate({ text: "boom" }).catch((error: unknown) => {
            rejected = error;
        });

        calls[0]?.reject(new Error("server said no"));
        await settled;

        expect(rejected).toBeInstanceOf(Error);
        expect(get(handleStore.isError)).toBe(true);
        expect(get(handleStore.error)?.message).toBe("server said no");

        handleStore.reset();

        expect(get(handleStore.error)).toBeUndefined();
        expect(get(handleStore.isError)).toBe(false);
    });

    it("ref-counts pending across overlapping invocations", async () => {
        const { calls, handle } = deferredHandle();
        const handleStore = mutator(handle);

        const first = handleStore.mutate({ text: "a" });
        const second = handleStore.mutate({ text: "b" });

        expect(get(handleStore.pending)).toBe(true);

        calls[0]?.resolve();
        await first;

        expect(get(handleStore.pending)).toBe(true);

        calls[1]?.resolve();
        await second;

        expect(get(handleStore.pending)).toBe(false);
    });
});
