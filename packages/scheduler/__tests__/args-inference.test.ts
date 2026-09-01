/**
 * Compile-time proof that scheduling a generated function reference is checked
 * against THAT function's args.
 *
 * It was not: the mirrored `FunctionReference` carried a `_args` phantom codegen
 * has never emitted, and `ArgsOf` read it through an optional property — which
 * every object type satisfies — so the inferred args were `unknown` and a call
 * with a typo'd key and a missing required field compiled clean. It then
 * persisted those args into the durable job and retried them until the budget
 * was gone.
 *
 * The `@ts-expect-error` lines below are the assertion: `lint:types` fails here
 * if the inference ever degrades again (an unused `@ts-expect-error` is itself an
 * error). Nothing in this file runs — the callback exists only to be typed.
 */
import { describe, expect, it } from "vitest";

import type { ArgsOf, FunctionReference, QueueWorkpool, Scheduler, Workpool } from "../src/types";

/** Stand-in for a generated `api.billing.charge` reference (see `_generated/api.ts`). */
type ChargeRef = FunctionReference<"mutation", { amount: number; currency: string }, { ok: boolean }>;

const charge = { __lunoraRef: "billing:charge" } as ChargeRef;
const scheduler = {} as Scheduler;
const workpool = {} as Workpool;
const queueWorkpool = {} as QueueWorkpool;

describe("argsOf", () => {
    it("resolves a reference's declared args instead of collapsing to unknown", () => {
        expect.assertions(1);

        const accepted: ArgsOf<ChargeRef> = { amount: 500, currency: "usd" };

        // @ts-expect-error -- `amonut` is a typo and the required `amount` is missing
        const rejected: ArgsOf<ChargeRef> = { amonut: 500, currency: "usd" };

        expect([accepted, rejected]).toHaveLength(2);
    });
});

describe("schedulable kinds", () => {
    it("refuses a stream reference, which the function runner cannot execute", () => {
        expect.assertions(1);

        const typeChecks = (): void => {
            // A scheduled job is dispatched as an ordinary `/rpc` call and the
            // function runner does not execute stream functions, so accepting one
            // compiles a job guaranteed to fail when its alarm fires — far from the
            // call site that scheduled it.
            const tail = { __lunoraRef: "messages:tail" } as FunctionReference<"stream", { channel: string }, void>;

            // @ts-expect-error -- `stream` is not a schedulable kind
            scheduler.runAfter(1000, tail, { channel: "general" }).catch(() => undefined);
            // @ts-expect-error -- same for the workpool
            workpool.enqueue(tail, { channel: "general" }).catch(() => undefined);
        };

        expect(typeChecks).toBeTypeOf("function");
    });
});

describe("scheduling entry points", () => {
    it("type-check their args against the target function", () => {
        expect.assertions(1);

        const typeChecks = async (): Promise<void> => {
            await scheduler.runAfter(1000, charge, { amount: 500, currency: "usd" });
            // @ts-expect-error -- `amonut` is a typo and the required `amount` is missing
            await scheduler.runAfter(1000, charge, { amonut: 500, currency: "usd" });

            await scheduler.runAt(Date.now(), charge, { amount: 500, currency: "usd" });
            // @ts-expect-error -- empty args, but `amount`/`currency` are required
            await scheduler.runAt(Date.now(), charge, {});

            await workpool.enqueue(charge, { amount: 500, currency: "usd" });
            // @ts-expect-error -- `amount` is missing
            await workpool.enqueue(charge, { currency: "usd" });

            await queueWorkpool.enqueue(charge, { amount: 500, currency: "usd" });
            // @ts-expect-error -- `amount` has the wrong type
            await queueWorkpool.enqueue(charge, { amount: "500", currency: "usd" });
        };

        expect(typeChecks).toBeTypeOf("function");
    });
});
