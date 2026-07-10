import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import type { SpendPolicy } from "../src/pay/policy";
import { assertBoundedPolicy, buildPaymentGuard, buildSpendPolicy, createSpendState, recordSpend, usdToAtomic } from "../src/pay/policy";

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
    it("allows a payment within the per-run cap, then blocks the one that would exceed it", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);
        const record = recordSpend(state);

        const first = await guard(guardContext(requirement({ amount: "15000" })));

        expect(first).toBeUndefined();

        await record(guardContext(requirement({ amount: "15000" })));

        expect(state.spentAtomic).toBe(15_000n);

        const second = await guard(guardContext(requirement({ amount: "10000" })));

        expect(second).toEqual({ abort: true, reason: expect.stringMatching(/per-run cap/) });
    });

    it("aborts when the confirmation gate declines", async () => {
        const onPaymentRequired = vi.fn<(r: PaymentRequirements) => boolean>(() => false);
        const guard = buildPaymentGuard({ onPaymentRequired }, createSpendState());

        const result = await guard(guardContext(requirement()));

        expect(result).toEqual({ abort: true, reason: expect.stringMatching(/declined by onPaymentRequired/) });
        expect(onPaymentRequired).toHaveBeenCalledTimes(1);
    });

    it("proceeds when the confirmation gate approves", async () => {
        const guard = buildPaymentGuard({ onPaymentRequired: () => true }, createSpendState());

        await expect(guard(guardContext(requirement()))).resolves.toBeUndefined();
    });
});

describe("recordSpend", () => {
    it("accumulates the selected requirement's amount", async () => {
        const state = createSpendState();
        const record = recordSpend(state);

        await record(guardContext(requirement({ amount: "700" })));
        await record(guardContext(requirement({ amount: "300" })));

        expect(state.spentAtomic).toBe(1000n);
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

    it("accepts any single bound", () => {
        const bounded: SpendPolicy[] = [
            { maxPerCall: "$0.01" },
            { maxPerRun: "$1" },
            { allowedRecipients: ["0x1111111111111111111111111111111111111111"] },
            { allowedNetworks: ["base"] },
            { onPaymentRequired: () => true },
        ];

        for (const policy of bounded) {
            expect(() => {
                assertBoundedPolicy(policy);
            }).not.toThrow();
        }
    });
});
