import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import type { SpendPolicy } from "../src/pay/policy";
import { assertBoundedPolicy, buildPaymentGuard, buildSpendPolicy, createSpendState, releaseSpendOnFailure, usdToAtomic } from "../src/pay/policy";

/** A PaymentRequirements fixture (USDC on Base by default; `amount` is atomic base units). */
const requirement = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => {
    return {
        amount: "10000",
        asset: "0xUSDC",
        extra: {},
        maxTimeoutSeconds: 60,
        network: "eip155:8453",
        payTo: "0x1111111111111111111111111111111111111111",
        scheme: "exact",
        ...overrides,
    };
};

/** A BeforePaymentCreationHook only reads `selectedRequirements`; build a minimal context. */
const guardContext = (selected: PaymentRequirements) =>
    ({ paymentRequired: { accepts: [selected], resource: {}, x402Version: 2 }, selectedRequirements: selected }) as never;

/** An OnPaymentCreationFailureHook only reads `selectedRequirements`; build a minimal context. */
const failureContext = (selected: PaymentRequirements) =>
    ({ error: new Error("signing failed"), paymentRequired: { accepts: [selected], resource: {}, x402Version: 2 }, selectedRequirements: selected }) as never;

describe("usdToAtomic", () => {
    it("converts USD (number, string, and $-prefixed) to 6-decimal atomic units", () => {
        expect(usdToAtomic(0.01)).toBe(10_000n);
        expect(usdToAtomic("0.01")).toBe(10_000n);
        expect(usdToAtomic("$0.01")).toBe(10_000n);
        expect(usdToAtomic("1")).toBe(1_000_000n);
        expect(usdToAtomic("1.5")).toBe(1_500_000n);
        expect(usdToAtomic("0.000001")).toBe(1n);
    });

    it("truncates below atomic granularity rather than rounding", () => {
        expect(usdToAtomic("0.0000019")).toBe(1n);
    });

    it("honours a custom decimals override", () => {
        expect(usdToAtomic("$1.23", 2)).toBe(123n);
    });

    it("rejects malformed amounts, including exponential notation", () => {
        expect(() => usdToAtomic("abc")).toThrow(/valid USD amount/);
        expect(() => usdToAtomic("1e-7")).toThrow(/valid USD amount/);
        expect(() => usdToAtomic("-1")).toThrow(/valid USD amount/);
        expect(() => usdToAtomic("0.01", -1)).toThrow(/non-negative integer/);
    });
});

describe("buildSpendPolicy", () => {
    it("filters out requirements over the per-call cap", () => {
        const policy = buildSpendPolicy({ maxPerCall: "$0.01" });
        const kept = policy(2, [requirement({ amount: "10000" }), requirement({ amount: "10001" })]);

        expect(kept.map((r) => r.amount)).toEqual(["10000"]);
    });

    it("returns an empty list (fail-closed) when nothing is within cap", () => {
        const policy = buildSpendPolicy({ maxPerCall: "$0.01" });

        expect(policy(2, [requirement({ amount: "20000" })])).toEqual([]);
    });

    it("filters by network allowlist (friendly names resolve to CAIP-2)", () => {
        const policy = buildSpendPolicy({ allowedNetworks: ["base"] });
        const kept = policy(2, [requirement({ network: "eip155:8453" }), requirement({ network: "eip155:1" })]);

        expect(kept.map((r) => r.network)).toEqual(["eip155:8453"]);
    });

    it("matches EVM recipients case-insensitively", () => {
        const policy = buildSpendPolicy({ allowedRecipients: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] });
        const kept = policy(2, [
            requirement({ payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            requirement({ payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
        ]);

        expect(kept.map((r) => r.payTo)).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    });
});

describe("buildPaymentGuard", () => {
    it("reserves atomically on pass, then blocks a subsequent payment that would exceed the per-run cap", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);

        const first = await guard(guardContext(requirement({ amount: "15000" })));

        // The reservation *is* the record: no separate after-hook call needed.
        expect(first).toBeUndefined();
        expect(state.spentAtomic).toBe(15_000n);

        const second = await guard(guardContext(requirement({ amount: "10000" })));

        expect(second).toEqual({ abort: true, reason: expect.stringMatching(/per-run cap/) });
        // The rejected attempt must not have reserved anything.
        expect(state.spentAtomic).toBe(15_000n);
    });

    it("aborts when the confirmation gate declines, releasing its reservation", async () => {
        const onPaymentRequired = vi.fn<(r: PaymentRequirements) => boolean>(() => false);
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1", onPaymentRequired }, state);

        const result = await guard(guardContext(requirement()));

        expect(result).toEqual({ abort: true, reason: expect.stringMatching(/declined by onPaymentRequired/) });
        expect(onPaymentRequired).toHaveBeenCalledTimes(1);
        // A declined confirmation must release the reservation it made while awaiting the gate.
        expect(state.spentAtomic).toBe(0n);
    });

    it("proceeds when the confirmation gate approves, keeping the reservation", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1", onPaymentRequired: () => true }, state);

        await expect(guard(guardContext(requirement({ amount: "10000" })))).resolves.toBeUndefined();
        expect(state.spentAtomic).toBe(10_000n);
    });

    it("closes the check-then-act race: two concurrent calls against one shared state cannot both pass (X402-02)", async () => {
        const state = createSpendState();
        // An async gate creates an await point between the cap check/reserve and the
        // guard's return, so both calls are in flight ("concurrent") at once —
        // exactly the shape of two parallel paid fetches sharing one PayFetch/state.
        const guard = buildPaymentGuard({ maxPerRun: "$0.02", onPaymentRequired: async () => true }, state);

        // Started back-to-back, not awaited individually: the first call's
        // synchronous check-and-reserve runs to completion (up to its first
        // `await`) before the second call's synchronous portion even begins.
        const first = guard(guardContext(requirement({ amount: "15000" })));
        const second = guard(guardContext(requirement({ amount: "10000" })));

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toBeUndefined();
        expect(secondResult).toEqual({ abort: true, reason: expect.stringMatching(/per-run cap/) });
        // Only the first payment's amount is reserved — no double-pass overspend.
        expect(state.spentAtomic).toBe(15_000n);
    });
});

describe("releaseSpendOnFailure", () => {
    it("releases a reservation so a subsequent guard call has capacity again", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);
        const release = releaseSpendOnFailure(state);

        const first = await guard(guardContext(requirement({ amount: "20000" })));

        expect(first).toBeUndefined();
        expect(state.spentAtomic).toBe(20_000n);

        // The scheme's signature creation failed after the guard reserved the amount.
        await release(failureContext(requirement({ amount: "20000" })));

        expect(state.spentAtomic).toBe(0n);

        const second = await guard(guardContext(requirement({ amount: "20000" })));

        expect(second).toBeUndefined();
    });

    it("clamps at zero rather than going negative", async () => {
        const state = createSpendState();
        const release = releaseSpendOnFailure(state);

        await release(failureContext(requirement({ amount: "500" })));

        expect(state.spentAtomic).toBe(0n);
    });
});

describe("assertBoundedPolicy", () => {
    it("refuses an unbounded policy", () => {
        expect(() => {
            assertBoundedPolicy({});
        }).toThrow(/unbounded spend policy/);
        expect(() => {
            assertBoundedPolicy({ allowedRecipients: [] });
        }).toThrow(/unbounded spend policy/);
    });

    it("refuses an allowlist-only policy (X402-03): allowedNetworks/allowedRecipients narrow but do not bound spend", () => {
        expect(() => {
            assertBoundedPolicy({ allowedNetworks: ["base"] });
        }).toThrow(/unbounded spend policy/);
        expect(() => {
            assertBoundedPolicy({ allowedRecipients: ["0x1111111111111111111111111111111111111111"] });
        }).toThrow(/unbounded spend policy/);
        expect(() => {
            assertBoundedPolicy({ allowedNetworks: ["base"], allowedRecipients: ["0x1111111111111111111111111111111111111111"] });
        }).toThrow(/unbounded spend policy/);
    });

    it("accepts any single real monetary/approval bound", () => {
        const bounded: SpendPolicy[] = [{ maxPerCall: "$0.01" }, { maxPerRun: "$1" }, { onPaymentRequired: () => true }];

        for (const policy of bounded) {
            expect(() => {
                assertBoundedPolicy(policy);
            }).not.toThrow();
        }
    });

    it("still accepts a bound policy that also carries allowlists (narrowing, not the bound itself)", () => {
        expect(() => {
            assertBoundedPolicy({ allowedNetworks: ["base"], maxPerCall: "$0.01" });
        }).not.toThrow();
    });
});
