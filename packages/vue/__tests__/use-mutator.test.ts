import { describe, expect, it } from "vitest";

import type { MutatorTransaction } from "../src/use-mutator";
import { useMutator } from "../src/use-mutator";

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

describe(useMutator, () => {
    it("flips `pending` while the transaction persists and clears it on success", async () => {
        const { calls, handle } = deferredHandle();
        const mutator = useMutator(handle);

        expect(mutator.pending.value).toBe(false);

        const settled = mutator.mutate({ text: "hi" });

        expect(mutator.pending.value).toBe(true);

        calls[0]?.resolve();
        await settled;

        expect(mutator.pending.value).toBe(false);
        expect(mutator.isError.value).toBe(false);
        expect(mutator.error.value).toBeUndefined();
    });

    it("captures the error, rejects `mutate`, and clears it on `reset`", async () => {
        const { calls, handle } = deferredHandle();
        const mutator = useMutator(handle);

        let rejected: unknown;
        const settled = mutator.mutate({ text: "boom" }).catch((error: unknown) => {
            rejected = error;
        });

        calls[0]?.reject(new Error("server said no"));
        await settled;

        expect(rejected).toBeInstanceOf(Error);
        expect(mutator.isError.value).toBe(true);
        expect(mutator.error.value?.message).toBe("server said no");

        mutator.reset();

        expect(mutator.error.value).toBeUndefined();
        expect(mutator.isError.value).toBe(false);
    });

    it("ref-counts `pending` across overlapping invocations", async () => {
        const { calls, handle } = deferredHandle();
        const mutator = useMutator(handle);

        const first = mutator.mutate({ text: "a" });
        const second = mutator.mutate({ text: "b" });

        expect(mutator.pending.value).toBe(true);

        calls[0]?.resolve();
        await first;

        expect(mutator.pending.value).toBe(true);

        calls[1]?.resolve();
        await second;

        expect(mutator.pending.value).toBe(false);
    });
});
