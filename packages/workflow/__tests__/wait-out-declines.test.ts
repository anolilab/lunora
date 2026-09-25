import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineStep } from "../src/define-step";
import { createWorkflowRunContext } from "../src/run-context";
import type { WorkflowEventLike, WorkflowStepConfigLike, WorkflowStepLike } from "../src/types";

const ENV = { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" };
const EVENT: WorkflowEventLike<Record<string, never>> = { instanceId: "inst-1", payload: {}, timestamp: new Date(0), workflowName: "order-pipeline" };

/** The body a shard answers a re-delivery with while the id's first run is still going. */
const declined = (): Response =>
    Response.json({ error: { code: "DISPATCH_IN_PROGRESS", message: "already running" } }, { headers: { "x-lunora-dispatch-declined": "1" }, status: 409 });

/** A dispatch origin that declines the first `declines` calls, then serves the result. */
const origin = (declines: number) => {
    let remaining = declines;

    return vi.fn<typeof fetch>(async () => {
        if (remaining > 0) {
            remaining -= 1;

            return declined();
        }

        return Response.json({ result: "charged" });
    });
};

const runner = (fetchImpl: typeof fetch) =>
    createWorkflowRunContext({ env: ENV, event: EVENT, exportName: "orderPipeline", fetchImpl, step: {} as WorkflowStepLike }).run;

describe("ctx.run — a DISPATCH_IN_PROGRESS decline", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-dispatches the same id until the first run's result is served, instead of throwing into the retry budget", async () => {
        expect.assertions(3);

        const fetchImpl = origin(3);
        const pending = runner(fetchImpl)({ __lunoraRef: "orders:charge" });

        await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

        await expect(pending).resolves.toBe("charged");
        // COUNT: three declines, one serve — and every dispatch carried the one pinned id.
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(new Set(fetchImpl.mock.calls.map((call) => (JSON.parse(call[1]?.body as string) as { id: string }).id))).toStrictEqual(
            new Set(["orderPipeline/inst-1#body.1"]),
        );
    });

    it("gives up after the claim ceiling and rethrows the decline to the engine's ordinary retry", async () => {
        expect.assertions(3);

        const fetchImpl = origin(Number.POSITIVE_INFINITY);
        const pending = runner(fetchImpl)({ __lunoraRef: "orders:charge" }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(15 * 60_000);

        const error = await pending;

        // Still a decline, never "done": the engine retries the step as for any retryable failure.
        expect(error).toBeInstanceOf(LunoraError);
        expect(error).toMatchObject({ code: "DISPATCH_IN_PROGRESS", status: 409 });

        // Bounded: 1s doubling to 30s pauses across fifteen minutes is a few dozen re-checks, not a spin.
        const calls = fetchImpl.mock.calls.length;

        await vi.advanceTimersByTimeAsync(60 * 60_000);

        expect(fetchImpl).toHaveBeenCalledTimes(calls);
    });

    it("rethrows instead of dispatching again when a late pause overran the claim ceiling", async () => {
        expect.assertions(2);

        const fetchImpl = origin(Number.POSITIVE_INFINITY);
        const pending = runner(fetchImpl)({ __lunoraRef: "orders:charge" }).catch((error: unknown) => error);

        // The first dispatch is declined and a 1s pause starts. The wall clock then
        // jumps past the ceiling before that timer fires: a timer that resumes late.
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(Date.now() + 16 * 60_000);
        await vi.advanceTimersByTimeAsync(1000);

        await expect(pending).resolves.toMatchObject({ code: "DISPATCH_IN_PROGRESS" });
        // COUNT: only the first dispatch; nothing was sent after the overrun.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    describe("inside ctx.runStep", () => {
        /** A native step double that runs the callback once, handing it `config` the way the engine does. */
        const stepApi = {
            do: async (name: string, config: unknown, callback: unknown) =>
                (callback as (context: unknown) => Promise<unknown>)({ attempt: 1, config, step: { count: 1, name } }),
        } as unknown as WorkflowStepLike;

        const runCharge = (fetchImpl: typeof fetch, config: WorkflowStepConfigLike) =>
            createWorkflowRunContext({ env: ENV, event: EVENT, exportName: "orderPipeline", fetchImpl, step: stepApi }).runStep(
                defineStep("charge", { args: {}, handler: async (context) => context.run({ __lunoraRef: "orders:charge" }) }),
                {},
                { config },
            );

        it.each([
            // The wait gives up 2s before the timeout, keeping 1s for a last dispatch: re-checks
            // at 0s, 1s and 3s.
            ["6 seconds", 6000, 3],
            [6000, 6000, 3],
            // Unset: Cloudflare's ten-minute default. Re-checks at 0s, 1s, 3s, 7s, 15s and 31s, every
            // 30s after that to 571s, and a last one cut short to 598s.
            [undefined, 600_000, 25],
        ])("ends the wait with the decline before a %s timeout", async (timeout, timeoutMs, dispatches) => {
            expect.assertions(3);

            const fetchImpl = origin(Number.POSITIVE_INFINITY);
            const pending = runCharge(fetchImpl, timeout === undefined ? {} : { timeout }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(timeoutMs - 2000);

            await expect(pending).resolves.toMatchObject({ code: "DISPATCH_IN_PROGRESS" });
            // COUNT, and nothing after: the abandoned attempt does not keep dispatching.
            expect(fetchImpl).toHaveBeenCalledTimes(dispatches);

            await vi.advanceTimersByTimeAsync(60 * 60_000);

            expect(fetchImpl).toHaveBeenCalledTimes(dispatches);
        });

        it("gives a re-check that may run the call no more timeoutMs than the attempt has left", async () => {
            expect.assertions(2);

            // Declines at +0s and +1s, then the claim is gone and the call runs:
            // with 3s of the 4s window left, that dispatch must not get its 30s.
            const signals: AbortSignal[] = [];
            let calls = 0;
            const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
                calls += 1;

                if (calls <= 2) {
                    return declined();
                }

                signals.push(init?.signal as AbortSignal);

                // A real fetch rejects when its signal aborts.
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason as Error);
                    });
                });
            });

            const pending = runCharge(fetchImpl, { timeout: "6 seconds" }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(4000);

            expect(signals.map((signal) => signal.aborted)).toStrictEqual([true]);
            // Ended by the bounded dispatch timeout, a retryable failure — inside the attempt.
            await expect(pending).resolves.toMatchObject({ status: 503 });
        });
    });

    // The engine hands a rollback the FORWARD step's context: on the local
    // Workflows engine, `timeout: "1 hour"` with `rollbackConfig: { timeout:
    // "7 seconds" }` gave the rollback `ctx.config.timeout === "1 hour"`. So the
    // rollback's wait has to be bounded by `rollbackConfig`, not by `ctx.config`.
    describe("inside a rollback", () => {
        /**
         * Run a step whose body makes no call, then its rollback, which makes one —
         * handing the rollback the forward `config` the way the engine does.
         */
        const rollbackOf = async (fetchImpl: typeof fetch, forward: WorkflowStepConfigLike, rollbackConfig: WorkflowStepConfigLike): Promise<void> => {
            let rollback: ((context: unknown) => Promise<void>) | undefined;
            const stepApi = {
                do: async (name: string, config: unknown, callback: unknown, options?: { rollback?: (context: unknown) => Promise<void> }) => {
                    rollback = options?.rollback;

                    return (callback as (context: unknown) => Promise<unknown>)({ attempt: 1, config, step: { count: 1, name } });
                },
            } as unknown as WorkflowStepLike;

            await createWorkflowRunContext({ env: ENV, event: EVENT, exportName: "orderPipeline", fetchImpl, step: stepApi }).runStep(
                defineStep("charge", {
                    args: {},
                    handler: async () => "charged",
                    rollback: async (context) => {
                        await context.run({ __lunoraRef: "orders:refund" });
                    },
                    rollbackConfig,
                }),
                {},
                { config: forward },
            );

            await rollback?.({
                ctx: { attempt: 1, config: forward, step: { count: 1, name: "charge" } },
                error: new Error("later step"),
                output: "charged",
                stepName: "charge",
            });
        };

        it("ends the wait before the rollback's own timeout when the forward step's is longer", async () => {
            expect.assertions(2);

            const fetchImpl = origin(Number.POSITIVE_INFINITY);
            const pending = rollbackOf(fetchImpl, { timeout: "1 hour" }, { timeout: "6 seconds" }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(4000);

            await expect(pending).resolves.toMatchObject({ code: "DISPATCH_IN_PROGRESS" });
            // COUNT: +0s, +1s and +3s — the rollback's 6s window, not the forward step's hour.
            expect(fetchImpl).toHaveBeenCalledTimes(3);
        });

        it("keeps waiting past the forward step's timeout when the rollback's is longer", async () => {
            expect.assertions(2);

            // Five declines (+0s … +15s), served on the sixth re-check at +31s:
            // well past the forward step's 6s, well inside the rollback's hour.
            const fetchImpl = origin(5);
            const pending = rollbackOf(fetchImpl, { timeout: "6 seconds" }, { timeout: "1 hour" });

            await vi.advanceTimersByTimeAsync(31_000);

            await expect(pending).resolves.toBeUndefined();
            expect(fetchImpl).toHaveBeenCalledTimes(6);
        });
    });

    it("rethrows any other failure at once", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }));

        await expect(runner(fetchImpl)({ __lunoraRef: "orders:charge" })).rejects.toMatchObject({ status: 500 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
