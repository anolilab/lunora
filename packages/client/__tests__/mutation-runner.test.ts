import { describe, expect, it, vi } from "vitest";

import type { MutationCallOptions } from "../src/lunora-client";
import { createMutationRunner } from "../src/mutation-runner";
import type { FunctionReference } from "../src/types";

/**
 * `createMutationRunner` is the framework-neutral half of the mutate hook shared by
 * `@lunora/solid`, `@lunora/vue`, and `@lunora/svelte` — every non-React adapter's
 * writes go through it. These tests pin its ref-counted `pending` bookkeeping, error
 * normalization, and pass-through behaviour directly against the
 * `MutationCapableClient` stub seam, without a framework runtime.
 */

/** The shape of the one method a mutation runner needs from its client. */
type MutationMethod = (function_: FunctionReference, args: unknown, options?: unknown) => Promise<unknown>;

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** A promise this test resolves/rejects on its own schedule. */
const deferred = <T>(): { promise: Promise<T>; reject: (error: unknown) => void; resolve: (value: T) => void } => {
    let resolveFn!: (value: T) => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });

    return { promise, reject: rejectFn, resolve: resolveFn };
};

describe("createMutationRunner", () => {
    it("happy path: setResult once, setPending sequence [true, false], setError never", async () => {
        expect.assertions(4);

        const mutation = vi.fn<MutationMethod>(async () => "ok");
        const pending: boolean[] = [];
        const results: unknown[] = [];
        const errors: Error[] = [];
        const runner = createMutationRunner({ mutation }, fnRef("todos:add"), {
            setError: (error) => errors.push(error),
            setPending: (value) => pending.push(value),
            setResult: (result) => results.push(result),
        });

        const result = await runner({});

        expect(result).toBe("ok");
        expect(results).toEqual(["ok"]);
        expect(pending).toEqual([true, false]);
        expect(errors).toEqual([]);
    });

    it("ref-counts overlapping calls: setPending(false) fires exactly once, only after the last call settles", async () => {
        expect.assertions(4);

        const first = deferred<string>();
        const second = deferred<string>();
        const mutation = vi
            .fn<MutationMethod>()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const pending: boolean[] = [];
        const runner = createMutationRunner({ mutation }, fnRef("todos:add"), {
            setError: () => {},
            setPending: (value) => pending.push(value),
            setResult: () => {},
        });

        const call1 = runner({});
        const call2 = runner({});

        expect(pending).toEqual([true, true]);

        first.resolve("a");
        await call1;

        // The second call is still in flight — `false` must not have fired yet
        // (call1's `finally` re-asserts `true` since `inFlight` is still 1).
        // This is the case that fails if `inFlight` is replaced with a boolean:
        // a naive boolean would clear `pending` here, while the second call runs.
        expect(pending).not.toContain(false);

        second.resolve("b");
        await call2;

        // `false` fires exactly once, only after the last call settles.
        expect(pending.filter((value) => !value)).toEqual([false]);
        expect(pending.at(-1)).toBe(false);
    });

    it("rejection with an Error: setError receives that instance, the call rejects with it, pending returns to false", async () => {
        expect.assertions(3);

        const boom = new Error("boom");
        const mutation = vi.fn<MutationMethod>().mockRejectedValue(boom);
        const pending: boolean[] = [];
        const errors: Error[] = [];
        const runner = createMutationRunner({ mutation }, fnRef("todos:add"), {
            setError: (error) => errors.push(error),
            setPending: (value) => pending.push(value),
            setResult: () => {},
        });

        await expect(runner({})).rejects.toBe(boom);
        expect(errors).toEqual([boom]);
        expect(pending).toEqual([true, false]);
    });

    it("rejection with a non-Error: normalizes to Error(String(thrown)), and the same normalized instance is what rejects", async () => {
        expect.assertions(4);

        const mutation = vi.fn<MutationMethod>().mockRejectedValue("nope");
        const errors: Error[] = [];
        const runner = createMutationRunner({ mutation }, fnRef("todos:add"), {
            setError: (error) => errors.push(error),
            setPending: () => {},
            setResult: () => {},
        });

        let caught: unknown;

        try {
            await runner({});
        } catch (error) {
            caught = error;
        }

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect(errors[0]?.message).toBe("nope");
        // Identity, not just shape — the same normalized instance both reaches
        // `setError` and is what the call rejects with.
        expect(caught).toBe(errors[0]);
    });

    it("passes options through to client.mutation unchanged (by reference)", async () => {
        expect.assertions(4);

        const mutation = vi.fn<MutationMethod>(async () => "ok");
        const runner = createMutationRunner({ mutation }, fnRef("todos:add"), {
            setError: () => {},
            setPending: () => {},
            setResult: () => {},
        });
        const options: MutationCallOptions = { shardKey: "room-1" };
        const args = { text: "hi" };

        await runner(args, options);

        expect(mutation).toHaveBeenCalledTimes(1);

        const [calledRef, calledArgs, calledOptions] = mutation.mock.calls[0]!;

        expect(calledRef).toEqual(fnRef("todos:add"));
        expect(calledArgs).toBe(args);
        expect(calledOptions).toBe(options);
    });
});
