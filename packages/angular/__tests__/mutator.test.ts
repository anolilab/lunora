import type { MutatorHandle, MutatorTransaction } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { mutator } from "../src/mutator";

const deferredHandle = (): { calls: { reject: (error: unknown) => void; resolve: () => void }[]; handle: MutatorHandle<{ text: string }> } => {
    const calls: { reject: (error: unknown) => void; resolve: () => void }[] = [];
    const handle: MutatorHandle<{ text: string }> = (_args: { text: string }): MutatorTransaction => {
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

describe(mutator, () => {
    it("flips pending while the transaction persists and clears it on success", async () => {
        const { calls, handle } = deferredHandle();
        const result = mutator(handle);

        expect(result.pending()).toBe(false);

        const settled = result.mutate({ text: "hi" });

        expect(result.pending()).toBe(true);

        calls[0]?.resolve();
        await settled;

        expect(result.pending()).toBe(false);
        expect(result.isError()).toBe(false);
        expect(result.error()).toBeUndefined();
    });

    it("captures the error, rejects mutate, and clears it on reset", async () => {
        const { calls, handle } = deferredHandle();
        const result = mutator(handle);

        let rejected: unknown;
        const settled = result.mutate({ text: "boom" }).catch((error: unknown) => {
            rejected = error;
        });

        calls[0]?.reject(new Error("server said no"));
        await settled;

        expect(rejected).toBeInstanceOf(Error);
        expect(result.isError()).toBe(true);
        expect(result.error()?.message).toBe("server said no");

        result.reset();

        expect(result.error()).toBeUndefined();
        expect(result.isError()).toBe(false);
    });

    it("ref-counts pending across overlapping invocations", async () => {
        const { calls, handle } = deferredHandle();
        const result = mutator(handle);

        const first = result.mutate({ text: "a" });
        const second = result.mutate({ text: "b" });

        expect(result.pending()).toBe(true);

        calls[0]?.resolve();
        await first;

        expect(result.pending()).toBe(true);

        calls[1]?.resolve();
        await second;

        expect(result.pending()).toBe(false);
    });
});
