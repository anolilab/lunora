import { v, ValidationError } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import { defineStep } from "../src/define-step";
import type { NativeNonRetryableErrorConstructor } from "../src/errors";
import { isNonRetryableError, NonRetryableError } from "../src/errors";
import { createRunStep } from "../src/run-step";
import type {
    WorkflowLogger,
    WorkflowRunFunction,
    WorkflowStepConfigLike,
    WorkflowStepContextLike,
    WorkflowStepLike,
    WorkflowStepRollbackOptionsLike,
} from "../src/types";

const noopLog: WorkflowLogger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} };

interface DoCall {
    config?: WorkflowStepConfigLike;
    name: string;
    rollback?: WorkflowStepRollbackOptionsLike;
}

/** A fake native step that runs the callback and records the config + rollback options per `do`. */
const makeFakeStep = (contextOverride?: Partial<WorkflowStepContextLike>) => {
    const calls: DoCall[] = [];
    const step = {
        do: (name: string, a: unknown, b?: unknown, c?: unknown) => {
            const hasConfig = typeof a !== "function";
            const config = hasConfig ? (a as WorkflowStepConfigLike) : undefined;
            const callback = (hasConfig ? b : a) as (context: WorkflowStepContextLike) => Promise<unknown>;
            const rollback = (hasConfig ? c : b) as WorkflowStepRollbackOptionsLike | undefined;

            calls.push({ config, name, rollback });

            return callback({ attempt: 1, config: config ?? {}, step: { count: 1, name }, ...contextOverride });
        },
        sleep: vi.fn<(name: string, duration: number | string) => Promise<void>>(),
        sleepUntil: vi.fn<(name: string, timestamp: Date | number) => Promise<void>>(),
        waitForEvent: vi.fn<(name: string, options: { timeout?: number | string; type: string }) => Promise<{ payload: Readonly<unknown>; type: string }>>(),
    } as unknown as WorkflowStepLike;

    return { calls, step };
};

const make = (overrides?: { nonRetryableErrorClass?: NativeNonRetryableErrorConstructor; step?: ReturnType<typeof makeFakeStep> }) => {
    const fake = overrides?.step ?? makeFakeStep();
    const run = vi.fn<WorkflowRunFunction>(async () => undefined);
    const runStep = createRunStep({
        env: { BUCKET: "bucket" },
        log: noopLog,
        nonRetryableErrorClass: overrides?.nonRetryableErrorClass,
        run,
        step: fake.step,
    });

    return { calls: fake.calls, run, runStep };
};

describe("createRunStep", () => {
    it("validates args, runs the body, and returns the result", async () => {
        expect.assertions(2);

        const { calls, runStep } = make();
        const greet = defineStep("greet", {
            args: { name: v.string() },
            handler: async (_ctx, { name }) => `hello ${name}`,
        });

        await expect(runStep(greet, { name: "ada" })).resolves.toBe("hello ada");
        expect(calls[0]?.name).toBe("greet");
    });

    it("rejects invalid args with a field-prefixed ValidationError before the body runs", async () => {
        expect.assertions(3);

        const { runStep } = make();
        const body = vi.fn<() => Promise<string>>(async () => "ok");
        const greet = defineStep("greet", { args: { name: v.string() }, handler: body });

        await expect(runStep(greet, { name: 123 as unknown as string })).rejects.toThrow(ValidationError);
        await expect(runStep(greet, { name: 123 as unknown as string })).rejects.toThrow(/step args\.name:/);
        expect(body).not.toHaveBeenCalled();
    });

    it("fails a `returns` mismatch as a non-retryable error (deterministic — retrying is pointless)", async () => {
        // A result-validation failure is deterministic: the body produced the same
        // bad output, so re-running it would fail `returns.parse` identically every
        // attempt. We therefore convert it to a (native, when available)
        // NonRetryableError so the instance fails fast instead of burning retries.
        expect.assertions(4);

        class FakeNative extends Error {
            public constructor(message: string, _name?: string) {
                super(message);
                this.name = "NonRetryableError";
            }
        }
        const { runStep } = make({ nonRetryableErrorClass: FakeNative });
        const liar = defineStep("liar", {
            args: {},
            handler: async () => ({ ok: "not-a-boolean" }) as unknown as { ok: boolean },
            returns: v.object({ ok: v.boolean() }),
        });

        const error = await runStep(liar, {}).then(
            () => undefined,
            (error_: unknown) => error_,
        );

        expect(error).toBeInstanceOf(FakeNative);
        // It must NOT surface as a (retryable) ValidationError.
        expect(error).not.toBeInstanceOf(ValidationError);
        expect((error as Error).message).toMatch(/returns validation failed/);
        // The original ValidationError is preserved as the cause for diagnostics.
        expect((error as Error).cause).toBeInstanceOf(ValidationError);
    });

    it("surfaces a portable NonRetryableError for a `returns` mismatch in Node (no native constructor)", async () => {
        expect.assertions(2);

        const { runStep } = make();
        const liar = defineStep("liar", {
            args: {},
            handler: async () => ({ ok: "not-a-boolean" }) as unknown as { ok: boolean },
            returns: v.object({ ok: v.boolean() }),
        });

        const error = await runStep(liar, {}).then(
            () => undefined,
            (error_: unknown) => error_,
        );

        expect(isNonRetryableError(error)).toBe(true);
        expect((error as Error).cause).toBeInstanceOf(ValidationError);
    });

    it("keeps a step-body throw retryable (rethrows it unchanged, not wrapped non-retryable)", async () => {
        // A body throw may be transient (network blip, contended write) — it must
        // stay retryable, so it is rethrown as-is and never wrapped into a
        // NonRetryableError. (Only post-execution returns-validation is fatal.)
        expect.assertions(2);

        class FakeNative extends Error {
            public constructor(message: string, _name?: string) {
                super(message);
                this.name = "NonRetryableError";
            }
        }
        const { runStep } = make({ nonRetryableErrorClass: FakeNative });
        const transient = new Error("transient upstream failure");
        const flaky = defineStep("flaky", {
            args: {},
            handler: async () => {
                throw transient;
            },
        });

        const error = await runStep(flaky, {}).then(
            () => undefined,
            (error_: unknown) => error_,
        );

        expect(error).toBe(transient);
        expect(isNonRetryableError(error)).toBe(false);
    });

    it("exposes attempt / env / run on the step context", async () => {
        expect.assertions(5);

        const fake = makeFakeStep({ attempt: 3 });
        const { run, runStep } = make({ step: fake });
        const probe = defineStep("probe", {
            args: {},
            handler: async (ctx) => {
                expect(ctx.attempt).toBe(3);
                expect(ctx.env).toEqual({ BUCKET: "bucket" });
                expect(ctx.run).toBe(run);
                expect(ctx.step.name).toBe("probe");

                return "done";
            },
        });

        await expect(runStep(probe, {})).resolves.toBe("done");
    });

    it("passes the step's config to native do, and lets a per-call override win", async () => {
        expect.assertions(2);

        const { calls, runStep } = make();
        const step = defineStep("cfg", { args: {}, config: { retries: { limit: 2 } }, handler: async () => 1 });

        await runStep(step, {});

        expect(calls[0]?.config).toEqual({ retries: { limit: 2 } });

        await runStep(step, {}, { config: { timeout: "10 seconds" } });

        expect(calls[1]?.config).toEqual({ timeout: "10 seconds" });
    });

    it("forwards a rollback handler to native do and maps its context", async () => {
        expect.assertions(4);

        const { calls, run, runStep } = make();
        const rollback = vi.fn<(context: unknown) => Promise<undefined>>(async (_context: unknown) => undefined);
        const publish = defineStep("publish", {
            args: { key: v.string() },
            handler: async () => "published",
            rollback,
            rollbackConfig: { retries: { limit: 1 } },
        });

        await runStep(publish, { key: "k1" });

        const options = calls[0]?.rollback;

        expect(options).toBeDefined();
        expect(options?.rollbackConfig).toEqual({ retries: { limit: 1 } });

        const failure = new Error("later step failed");

        await options?.rollback?.({
            ctx: { attempt: 1, config: {}, step: { count: 1, name: "publish" } },
            error: failure,
            output: "published",
            stepName: "publish",
        });

        expect(rollback).toHaveBeenCalledTimes(1);
        expect(rollback.mock.calls[0]?.[0]).toEqual({
            args: { key: "k1" },
            env: { BUCKET: "bucket" },
            error: failure,
            log: noopLog,
            output: "published",
            run,
        });
    });

    it("omits rollback options when the step declares no rollback", async () => {
        expect.assertions(1);

        const { calls, runStep } = make();
        const step = defineStep("plain", { args: {}, handler: async () => 1 });

        await runStep(step, {});

        expect(calls[0]?.rollback).toBeUndefined();
    });

    it("converts a portable NonRetryableError to the native one when a constructor is injected", async () => {
        expect.assertions(1);

        class FakeNative extends Error {
            public constructor(message: string, _name?: string) {
                super(message);
            }
        }
        const { runStep } = make({ nonRetryableErrorClass: FakeNative });
        const step = defineStep("boom", {
            args: {},
            handler: async () => {
                throw new NonRetryableError("fatal");
            },
        });

        await expect(runStep(step, {})).rejects.toThrow(FakeNative);
    });

    it("rethrows a portable NonRetryableError unchanged in Node (no native constructor)", async () => {
        expect.assertions(1);

        const { runStep } = make();
        const portable = new NonRetryableError("fatal");
        const step = defineStep("boom", {
            args: {},
            handler: async () => {
                throw portable;
            },
        });

        await expect(runStep(step, {})).rejects.toBe(portable);
    });
});
