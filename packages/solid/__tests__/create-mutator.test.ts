import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { MutatorTransaction } from "../src/create-mutator";
import { createMutator } from "../src/create-mutator";

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

describe(createMutator, () => {
    it("flips pending() while the transaction persists and clears it on success", async () => {
        await createRoot(async (dispose) => {
            const { calls, handle } = deferredHandle();
            const mutator = createMutator(handle);

            expect(mutator.pending()).toBe(false);

            const settled = mutator.mutate({ text: "hi" });

            expect(mutator.pending()).toBe(true);

            calls[0]?.resolve();
            await settled;

            expect(mutator.pending()).toBe(false);
            expect(mutator.isError()).toBe(false);
            expect(mutator.error()).toBeUndefined();

            dispose();
        });
    });

    it("captures the error, rejects mutate, and clears it on reset", async () => {
        await createRoot(async (dispose) => {
            const { calls, handle } = deferredHandle();
            const mutator = createMutator(handle);

            let rejected: unknown;
            const settled = mutator.mutate({ text: "boom" }).catch((error: unknown) => {
                rejected = error;
            });

            calls[0]?.reject(new Error("server said no"));
            await settled;

            expect(rejected).toBeInstanceOf(Error);
            expect(mutator.isError()).toBe(true);
            expect(mutator.error()?.message).toBe("server said no");

            mutator.reset();

            expect(mutator.error()).toBeUndefined();
            expect(mutator.isError()).toBe(false);

            dispose();
        });
    });

    it("ref-counts pending() across overlapping invocations", async () => {
        await createRoot(async (dispose) => {
            const { calls, handle } = deferredHandle();
            const mutator = createMutator(handle);

            const first = mutator.mutate({ text: "a" });
            const second = mutator.mutate({ text: "b" });

            expect(mutator.pending()).toBe(true);

            calls[0]?.resolve();
            await first;

            expect(mutator.pending()).toBe(true);

            calls[1]?.resolve();
            await second;

            expect(mutator.pending()).toBe(false);

            dispose();
        });
    });
});
