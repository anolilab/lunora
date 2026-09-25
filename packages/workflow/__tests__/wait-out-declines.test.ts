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
            // The wait gives up 2s before the timeout: re-checks at 0s, 1s, 3s and 4s.
            ["6 seconds", 6000, 4],
            [6000, 6000, 4],
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
    });

    it("rethrows any other failure at once", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }));

        await expect(runner(fetchImpl)({ __lunoraRef: "orders:charge" })).rejects.toMatchObject({ status: 500 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
