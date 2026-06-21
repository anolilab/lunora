import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { augmentWorkerStartupError, isWorkerEntryEvalError, withWorkerStartupHint, WORKER_STARTUP_HINT } from "../src/worker-startup-hint";

/** A realistic Worker-entry eval failure as `@cloudflare/vite-plugin` surfaces it. */
const makeRunnerWorkerError = (): Error => {
    const error = new TypeError("Cannot read properties of undefined (reading 'string')");

    error.stack = [
        "TypeError: Cannot read properties of undefined (reading 'string')",
        "    at runInRunnerObject (workers/runner-worker/index.js:107:3)",
        "    at getWorkerEntryExportTypes (workers/runner-worker/index.js:246:24)",
    ].join("\n");

    return error;
};

describe("isWorkerEntryEvalError", () => {
    it("recognises a runner-worker eval failure", () => {
        expect.assertions(1);

        expect(isWorkerEntryEvalError(makeRunnerWorkerError())).toBe(true);
    });

    it("ignores unrelated errors and non-errors", () => {
        expect.assertions(3);

        expect(isWorkerEntryEvalError(new Error("ENOENT: no such file"))).toBe(false);
        expect(isWorkerEntryEvalError("Cannot read properties of undefined (reading 'string')")).toBe(false);
        expect(isWorkerEntryEvalError(undefined)).toBe(false);
    });
});

describe("augmentWorkerStartupError", () => {
    it("appends the actionable hint to a recognised error", () => {
        expect.assertions(4);

        const error = augmentWorkerStartupError(makeRunnerWorkerError()) as Error;

        expect(error.message).toContain("Cannot read properties of undefined (reading 'string')");
        expect(error.message).toContain("circular import");
        expect(error.message).toContain("lunora codegen");
        // Vite's CLI prints `util.inspect(error)`, which renders the stack — so the
        // hint must reach `.stack`, not just `.message`, to actually be seen.
        expect(error.stack).toContain("circular import");
    });

    it("is idempotent — the hint is never appended twice", () => {
        expect.assertions(1);

        const once = augmentWorkerStartupError(makeRunnerWorkerError()) as Error;
        const twice = augmentWorkerStartupError(once) as Error;

        const occurrences = twice.message.split(WORKER_STARTUP_HINT).length - 1;

        expect(occurrences).toBe(1);
    });

    it("leaves unrelated errors untouched", () => {
        expect.assertions(1);

        const original = new Error("boom");

        expect((augmentWorkerStartupError(original) as Error).message).toBe("boom");
    });

    it("does not throw on a frozen error (returns it untouched)", () => {
        expect.assertions(2);

        const frozen = Object.freeze(makeRunnerWorkerError());

        const result = augmentWorkerStartupError(frozen) as Error;

        expect(result).toBe(frozen);
        // The hint could not be appended (frozen), so the message is unchanged.
        expect(result.message).toBe("Cannot read properties of undefined (reading 'string')");
    });
});

describe("withWorkerStartupHint", () => {
    it("wraps a function-form configureServer so the thrown error gains the hint", async () => {
        expect.assertions(2);

        const plugin: Plugin = {
            name: "fake-cloudflare",
            configureServer() {
                throw makeRunnerWorkerError();
            },
        };

        const [wrapped] = withWorkerStartupHint([plugin]);
        const hook = wrapped?.configureServer as () => Promise<void>;

        await expect(hook()).rejects.toThrow("circular import");
        // The original plugin object is not mutated.
        expect(() => {
            (plugin.configureServer as () => void)();
        }).toThrow(/^Cannot read properties of undefined \(reading 'string'\)$/u);
    });

    it("wraps the object-form `{ handler }` hook shape", async () => {
        expect.assertions(1);

        const plugin = {
            name: "fake-cloudflare",
            buildStart: {
                handler() {
                    throw makeRunnerWorkerError();
                },
                order: "pre",
            },
        } as unknown as Plugin;

        const [wrapped] = withWorkerStartupHint([plugin]);
        const { handler } = wrapped?.buildStart as { handler: () => Promise<void> };

        await expect(handler()).rejects.toThrow("lunora codegen");
    });

    it("passes through a successful hook result unchanged", async () => {
        expect.assertions(1);

        const plugin: Plugin = {
            name: "fake-cloudflare",
            buildStart() {
                return undefined;
            },
        };

        const [wrapped] = withWorkerStartupHint([plugin]);

        await expect((wrapped?.buildStart as () => Promise<void>)()).resolves.toBeUndefined();
    });
});
