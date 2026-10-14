import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MutatorTransaction } from "../src/use-mutator";
import { useMutator } from "../src/use-mutator";

/** A controllable bound-mutator handle: returns a transaction whose persist promise we resolve/reject by hand. */
const deferredHandle = () => {
    const calls: { reject: (error: unknown) => void; resolve: () => void }[] = [];
    const handle = (_args: { title: string }): MutatorTransaction => {
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

describe("useMutator", () => {
    it("flips `pending` while the transaction persists and clears it on success", async () => {
        expect.hasAssertions();

        const { calls, handle } = deferredHandle();
        const { result } = renderHook(() => useMutator(handle));

        expect(result.current.pending).toBe(false);

        let settled: Promise<void> = Promise.resolve();

        act(() => {
            settled = result.current.mutate({ title: "hi" });
        });

        await waitFor(() => {
            expect(result.current.pending).toBe(true);
        });

        await act(async () => {
            calls[0]?.resolve();
            await settled;
        });

        expect(result.current.pending).toBe(false);
        expect(result.current.isError).toBe(false);
    });

    it("captures the error, rejects `mutate`, and clears it on `reset`", async () => {
        expect.hasAssertions();

        const { calls, handle } = deferredHandle();
        const { result } = renderHook(() => useMutator(handle));

        let rejected: unknown;

        await act(async () => {
            const settled = result.current.mutate({ title: "boom" }).catch((error: unknown) => {
                rejected = error;
            });

            calls[0]?.reject(new Error("server said no"));
            await settled;
        });

        expect(rejected).toBeInstanceOf(Error);
        expect(result.current.isError).toBe(true);
        expect(result.current.error?.message).toBe("server said no");

        act(() => {
            result.current.reset();
        });

        expect(result.current.error).toBeUndefined();
        expect(result.current.isError).toBe(false);
    });

    it("ref-counts `pending` across overlapping invocations", async () => {
        expect.hasAssertions();

        const { calls, handle } = deferredHandle();
        const { result } = renderHook(() => useMutator(handle));

        let first: Promise<void> = Promise.resolve();
        let second: Promise<void> = Promise.resolve();

        act(() => {
            first = result.current.mutate({ title: "a" });
            second = result.current.mutate({ title: "b" });
        });

        await waitFor(() => {
            expect(result.current.pending).toBe(true);
        });

        // First settles — still pending because the second is in flight.
        await act(async () => {
            calls[0]?.resolve();
            await first;
        });

        expect(result.current.pending).toBe(true);

        await act(async () => {
            calls[1]?.resolve();
            await second;
        });

        expect(result.current.pending).toBe(false);
    });
});
