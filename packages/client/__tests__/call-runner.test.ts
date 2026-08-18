import { describe, expect, it, vi } from "vitest";

import { createCallRunner } from "../src/call-runner";

/**
 * `createCallRunner` is the framework-neutral half of BOTH write primitives —
 * every non-React adapter's `mutate` and every adapter's `call` go through it.
 * These tests pin its ref-counted `pending` bookkeeping, error normalization,
 * latest-invocation ordering, and pass-through behaviour directly against a stub
 * thunk, without a framework runtime.
 */

/** A promise this test resolves/rejects on its own schedule. */
const deferred = <T>(): { promise: Promise<T>; reject: (error: unknown) => void; resolve: (value: T) => void } => {
    let resolveFunction!: (value: T) => void;
    let rejectFunction!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFunction = resolve;
        rejectFunction = reject;
    });

    return { promise, reject: rejectFunction, resolve: resolveFunction };
};

/** Collects what the runner pushes into an adapter's reactive setters. */
const createSinks = () => {
    const errors: Error[] = [];
    const pendings: boolean[] = [];
    const results: unknown[] = [];

    return {
        errors,
        pendings,
        results,
        sinks: {
            setError: (error: Error) => {
                errors.push(error);
            },
            setPending: (pending: boolean) => {
                pendings.push(pending);
            },
            setResult: (result: unknown) => {
                results.push(result);
            },
        },
    };
};

describe(createCallRunner, () => {
    it("forwards args and options to the bound thunk unchanged, by reference", async () => {
        expect.assertions(3);

        const invoke = vi.fn<(args: unknown, options?: unknown) => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const { sinks } = createSinks();
        const args = { command: "lunora" };
        const options = { shardKey: "project-1" };

        const result = await createCallRunner(invoke, sinks)(args, options);

        expect(result).toStrictEqual({ code: 0 });
        expect(invoke.mock.calls[0]?.[0]).toBe(args);
        expect(invoke.mock.calls[0]?.[1]).toBe(options);
    });

    it("pushes pending true then false around a single call", async () => {
        expect.assertions(3);

        const invoke = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const { errors, pendings, results, sinks } = createSinks();

        await createCallRunner(invoke, sinks)({ command: "lunora" });

        expect(pendings).toStrictEqual([true, false]);
        expect(results).toStrictEqual([{ code: 0 }]);
        expect(errors).toStrictEqual([]);
    });

    it("ref-counts overlapping calls so pending clears only after the last settles", async () => {
        expect.assertions(2);

        const first = deferred<unknown>();
        const second = deferred<unknown>();
        const invoke = vi.fn<() => Promise<unknown>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { pendings, sinks } = createSinks();

        const call = createCallRunner(invoke, sinks);
        const both = Promise.all([call({ command: "a" }), call({ command: "b" })]);

        first.resolve({ code: 0 });
        await Promise.resolve();

        // The property that matters is the absence of `false`, not a particular
        // count of `true`s: the first call's `finally` re-pushes `true` because
        // the second is still in flight, so the sink legitimately sees three.
        expect(pendings).not.toContain(false);

        second.resolve({ code: 0 });
        await both;

        expect(pendings.at(-1)).toBe(false);
    });

    it("normalizes a thrown non-Error, reports it, and re-throws", async () => {
        expect.assertions(4);

        const invoke = vi.fn<() => Promise<unknown>>().mockRejectedValue("refused");
        const { errors, pendings, sinks } = createSinks();

        // A consumer should always be able to read `.message`, whatever the
        // server threw — that normalization is why this lives in one place
        // rather than in each adapter.
        await expect(createCallRunner(invoke, sinks)({ command: "bash" })).rejects.toThrow("refused");

        expect(errors[0]).toBeInstanceOf(Error);
        expect(errors[0]?.message).toBe("refused");
        expect(pendings.at(-1)).toBe(false);
    });

    it("re-throws the SAME error instance it reported to the sink", async () => {
        expect.assertions(2);

        const thrown = new Error("command refused");
        const invoke = vi.fn<() => Promise<unknown>>().mockRejectedValue(thrown);
        const { errors, sinks } = createSinks();

        // Identity matters: a caller catching the rejection and a template
        // reading `error` must be looking at one object, or a typed error's
        // extra fields survive in one place and not the other.
        await expect(createCallRunner(invoke, sinks)({ command: "bash" })).rejects.toBe(thrown);
        expect(errors[0]).toBe(thrown);
    });

    it("ignores an earlier call's result when a later one already settled", async () => {
        expect.assertions(1);

        const slow = deferred<unknown>();
        const fast = deferred<unknown>();
        const invoke = vi.fn<() => Promise<unknown>>().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
        const { results, sinks } = createSinks();

        const call = createCallRunner(invoke, sinks);
        // The double-click: click 1 is slow, click 2 is fast. What the user is
        // looking at is click 2's outcome, so click 1 landing later must not
        // overwrite it.
        const both = Promise.all([call({ command: "a" }), call({ command: "b" })]);

        fast.resolve("B");
        await Promise.resolve();
        slow.resolve("A");
        await both;

        expect(results).toStrictEqual(["B"]);
    });

    it("ignores an earlier call's error when a later one already succeeded", async () => {
        expect.assertions(3);

        const slow = deferred<unknown>();
        const fast = deferred<unknown>();
        const invoke = vi.fn<() => Promise<unknown>>().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
        const { errors, results, sinks } = createSinks();

        const call = createCallRunner(invoke, sinks);
        const stale = call({ command: "a" });
        const latest = call({ command: "b" });

        fast.resolve("B");
        await latest;

        slow.reject(new Error("stale failure"));

        // The rejection still propagates to ITS caller — only the shared
        // `error` sink is protected, so a template never shows a failure
        // banner for a call that succeeded.
        await expect(stale).rejects.toThrow("stale failure");

        expect(errors).toStrictEqual([]);
        expect(results).toStrictEqual(["B"]);
    });
});
