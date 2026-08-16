import { describe, expect, it, vi } from "vitest";

import { createActionRunner } from "../src/action-runner";
import type { FunctionReference } from "../src/types";

const runRef = { __lunoraRef: "commands:run" } as FunctionReference;

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

describe(createActionRunner, () => {
    it("forwards the reference, args and options to client.action", async () => {
        expect.assertions(2);

        const action = vi.fn<(function_: unknown, args: unknown, options?: unknown) => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const { sinks } = createSinks();

        const call = createActionRunner({ action }, runRef, sinks);
        const result = await call({ command: "lunora" }, { shardKey: "project-1" });

        expect(result).toStrictEqual({ code: 0 });
        expect(action).toHaveBeenCalledWith(runRef, { command: "lunora" }, { shardKey: "project-1" });
    });

    it("pushes pending true then false around a single call", async () => {
        expect.assertions(2);

        const action = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const { pendings, results, sinks } = createSinks();

        await createActionRunner({ action }, runRef, sinks)({ command: "lunora" });

        expect(pendings).toStrictEqual([true, false]);
        expect(results).toStrictEqual([{ code: 0 }]);
    });

    it("ref-counts overlapping calls so pending clears only after the last settles", async () => {
        expect.assertions(2);

        const resolvers: ((value: unknown) => void)[] = [];
        const action = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        const { pendings, sinks } = createSinks();

        const call = createActionRunner({ action }, runRef, sinks);
        const both = Promise.all([call({ command: "a" }), call({ command: "b" })]);

        resolvers[0]?.({ code: 0 });
        await Promise.resolve();

        // The property that matters is the absence of `false`, not a particular
        // count of `true`s: the first call's `finally` re-pushes `true` because
        // the second is still in flight, so the sink legitimately sees three.
        // Asserting a count here would pin an implementation detail and fail on
        // a harmless refactor.
        expect(pendings).not.toContain(false);

        resolvers[1]?.({ code: 0 });
        await both;

        expect(pendings.at(-1)).toBe(false);
    });

    it("normalizes a thrown non-Error, reports it, and re-throws", async () => {
        expect.assertions(4);

        const action = vi.fn<() => Promise<unknown>>().mockRejectedValue("refused");
        const { errors, pendings, sinks } = createSinks();

        // A consumer should always be able to read `.message`, whatever the
        // server threw — that normalization is why this lives in one place
        // rather than in each adapter.
        await expect(createActionRunner({ action }, runRef, sinks)({ command: "bash" })).rejects.toThrow("refused");

        expect(errors[0]).toBeInstanceOf(Error);
        expect(errors[0]?.message).toBe("refused");
        expect(pendings.at(-1)).toBe(false);
    });

    it("re-throws the SAME error instance it reported to the sink", async () => {
        expect.assertions(2);

        const thrown = new Error("command refused");
        const action = vi.fn<() => Promise<unknown>>().mockRejectedValue(thrown);
        const { errors, sinks } = createSinks();

        // Identity matters: a caller catching the rejection and a template
        // reading `error` must be looking at one object, or a typed error's
        // extra fields survive in one place and not the other.
        await expect(createActionRunner({ action }, runRef, sinks)({ command: "bash" })).rejects.toBe(thrown);
        expect(errors[0]).toBe(thrown);
    });
});
