/**
 * Compile-time proof that `ctx.run(fn, args)` inside a workflow is checked
 * against THAT function's args.
 *
 * It was not: the mirrored `FunctionReference` carried a `_args` phantom codegen
 * has never emitted, and `ArgsOf` read it through an optional property — which
 * every object type satisfies — so the inferred args were `unknown`. Malformed
 * args then landed in a durable step's memoized input and were retried, byte for
 * byte, until the retry budget was gone.
 *
 * The `@ts-expect-error` lines below are the assertion: `lint:types` fails here
 * if the inference ever degrades again (an unused `@ts-expect-error` is itself an
 * error). Nothing in this file runs — the callback exists only to be typed.
 */
import { describe, expect, it } from "vitest";

import type { ArgsOf, FunctionReference, WorkflowRunFunction } from "../src/types";

/** Stand-in for a generated `api.billing.charge` reference (see `_generated/api.ts`). */
type ChargeRef = FunctionReference<"mutation", { amount: number; currency: string }, { ok: boolean }>;

const charge = { __lunoraRef: "billing:charge" } as ChargeRef;
const run = (() => Promise.resolve(undefined)) as WorkflowRunFunction;

describe("argsOf", () => {
    it("resolves a reference's declared args instead of collapsing to unknown", () => {
        expect.assertions(1);

        const accepted: ArgsOf<ChargeRef> = { amount: 500, currency: "usd" };

        // @ts-expect-error -- `amonut` is a typo and the required `amount` is missing
        const rejected: ArgsOf<ChargeRef> = { amonut: 500, currency: "usd" };

        expect([accepted, rejected]).toHaveLength(2);
    });
});

describe("ctx.run", () => {
    it("type-checks its args against the target function", () => {
        expect.assertions(1);

        const typeChecks = async (): Promise<void> => {
            await run(charge, { amount: 500, currency: "usd" });
            // @ts-expect-error -- `amonut` is a typo and the required `amount` is missing
            await run(charge, { amonut: 500, currency: "usd" });
            // @ts-expect-error -- `amount` has the wrong type
            await run(charge, { amount: "500", currency: "usd" });
        };

        expect(typeChecks).toBeTypeOf("function");
    });
});
