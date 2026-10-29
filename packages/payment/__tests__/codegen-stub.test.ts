import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LunoraPayment } from "../src/create-payment";

type CallableKey = { [K in keyof LunoraPayment]: LunoraPayment[K] extends (...args: never[]) => unknown ? K : never }[keyof LunoraPayment];

// Fails to type-check when a method is added to or removed from `LunoraPayment`.
const METHODS = {
    attach: true,
    cancelPayment: true,
    cancelSubscription: true,
    capturePayment: true,
    check: true,
    createCheckout: true,
    createPortalSession: true,
    handleWebhook: true,
    listBalances: true,
    listSubscriptions: true,
    refundPayment: true,
    track: true,
} satisfies Record<CallableKey, true>;

const GENERATED_SHARD = join(import.meta.dirname, "..", "..", "..", "examples", "payment-demo", "lunora", "_generated", "shard.ts");

/** Codegen's `PAYMENT_METHODS` hand-mirrors `LunoraPayment`; its `as unknown` cast hides a missing member. */
describe("codegen paymentStub", () => {
    it("stubs exactly the callable members of LunoraPayment", () => {
        expect.assertions(1);

        const source = readFileSync(GENERATED_SHARD, "utf8");
        const stub = source.slice(source.indexOf("const paymentStub"), source.indexOf("} as unknown as LunoraPayment;"));
        const stubbed = [...stub.matchAll(/^ {4}(\w+): /gm)].map((match) => match[1] ?? "");

        expect(stubbed.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(Object.keys(METHODS).toSorted((a, b) => a.localeCompare(b)));
    });
});
