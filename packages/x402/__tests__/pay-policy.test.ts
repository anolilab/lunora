import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import type { SpendPolicy } from "../src/pay/policy";
import {
    assertBoundedPolicy,
    buildPaymentGuard,
    buildSpendPolicy,
    createSpendState,
    DEFAULT_ALLOWED_ASSETS,
    releaseSpendOnFailure,
    usdToAtomic,
} from "../src/pay/policy";

/**
 * Real asset addresses, because the policy now gates on them. These must match
 * {@link DEFAULT_ALLOWED_ASSETS} — a requirement naming anything else is refused.
 */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Some other token contract on Base. Not a dollar stablecoin, and not in the default allowlist. */
const OTHER_ASSET = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

/** A PaymentRequirements fixture (USDC on Base by default; `amount` is atomic base units). */
const requirement = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => {
    return {
        amount: "10000",
        asset: USDC_BASE,
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
        // Both are allowed *assets* (USDC on Base, USDC on Polygon), so the network
        // allowlist is what does the filtering here rather than the asset gate.
        const kept = policy(2, [requirement(), requirement({ asset: USDC_POLYGON, network: "eip155:137" })]);

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

describe("buildSpendPolicy — asset gate (X402-01)", () => {
    it("refuses a requirement whose asset is not on the allowlist, even under the per-call cap", () => {
        // The exploit: the server names the token contract the scheme will sign a
        // transfer against. Against a wrapped-BTC-style token (8 decimals, ~$100k a coin)
        // 10000 atomic units is ~$0.01 *of USDC* but ~$10 of that token — it slips under a
        // $0.01 cap priced at an assumed 6 decimals while moving a thousand times the
        // authorised value. Whatever the wallet happens to hold, the policy must pin which
        // asset the cap is denominated in.
        const policy = buildSpendPolicy({ maxPerCall: "$0.01" });

        expect(policy(2, [requirement({ amount: "10000", asset: OTHER_ASSET })])).toEqual([]);
    });

    it("keeps a known-stablecoin requirement under the cap", () => {
        const policy = buildSpendPolicy({ maxPerCall: "$0.01" });

        expect(policy(2, [requirement({ amount: "10000" })])).toHaveLength(1);
    });

    it("refuses a known asset offered on the wrong network", () => {
        // Base USDC's address on Polygon is not Polygon USDC — the pair is what's allowed.
        const policy = buildSpendPolicy({ maxPerCall: "$1" });

        expect(policy(2, [requirement({ asset: USDC_BASE, network: "eip155:137" })])).toEqual([]);
    });

    it("matches EVM asset addresses case-insensitively but SVM mints exactly", () => {
        const policy = buildSpendPolicy({ maxPerCall: "$1" });

        expect(policy(2, [requirement({ asset: USDC_BASE.toUpperCase().replace("0X", "0x") })])).toHaveLength(1);
        expect(policy(2, [requirement({ asset: USDC_SOLANA, network: SOLANA_MAINNET })])).toHaveLength(1);
        // Base58 is case-sensitive: a differently-cased mint is a different account.
        expect(policy(2, [requirement({ asset: USDC_SOLANA.toLowerCase(), network: SOLANA_MAINNET })])).toEqual([]);
    });

    it("scales the per-call cap by the matched asset's decimals, not an assumed 6", () => {
        const policy = buildSpendPolicy({
            allowedAssets: [{ asset: OTHER_ASSET, decimals: 18, network: "base" }],
            maxPerCall: "$1",
        });

        // $1 of an 18-decimal asset is 1e18 atomic units. Under an assumed 6 decimals the
        // cap would have been 1e6 and every one of these would have been refused.
        expect(policy(2, [requirement({ amount: (10n ** 18n).toString(), asset: OTHER_ASSET })])).toHaveLength(1);
        expect(policy(2, [requirement({ amount: (10n ** 18n + 1n).toString(), asset: OTHER_ASSET })])).toEqual([]);
    });

    it("defaults to canonical USDC per friendly network", () => {
        expect(DEFAULT_ALLOWED_ASSETS.every((asset) => asset.decimals === 6)).toBe(true);
        expect(DEFAULT_ALLOWED_ASSETS.map((asset) => asset.network)).toContain("base");
    });

    it("rejects a policy that cannot express a real asset gate", () => {
        expect(() => buildSpendPolicy({ allowedAssets: [], maxPerCall: "$1" })).toThrow(/allowedAssets` is empty/);
        expect(() => buildSpendPolicy({ allowedAssets: [{ asset: USDC_BASE, decimals: -1, network: "base" }] })).toThrow(/non-negative integer/);
    });

    it("refuses two entries for one asset that disagree on decimals", () => {
        // Silently taking the last would pick a precision at random — the very
        // mis-pricing the asset gate exists to prevent. Easy to hit when two
        // allowlists are concatenated.
        expect(() =>
            buildSpendPolicy({
                allowedAssets: [
                    { asset: USDC_BASE, decimals: 6, network: "base" },
                    { asset: USDC_BASE, decimals: 18, network: "base" },
                ],
                maxPerCall: "$1",
            }),
        ).toThrow(/twice with different decimals/);
    });

    it("tolerates a duplicate entry that agrees on decimals", () => {
        const policy = buildSpendPolicy({
            allowedAssets: [
                { asset: USDC_BASE, decimals: 6, network: "base" },
                // Same asset written case-differently on the same network — still one entry.
                { asset: USDC_BASE.toLowerCase(), decimals: 6, network: "base" },
            ],
            maxPerCall: "$1",
        });

        expect(policy(2, [requirement()])).toHaveLength(1);
    });

    it("refuses a server amount that isn't a canonical atomic quantity", () => {
        const policy = buildSpendPolicy({ maxPerCall: "$1" });

        // `BigInt` would throw on the first three (an exception escaping the filter
        // instead of a fail-closed rejection) and *accept* the negative one, whose
        // value slips under every cap comparison.
        for (const amount of ["", "abc", "1.5", "1e6", " 10000", "0x10", "-1"]) {
            expect(policy(2, [requirement({ amount })])).toEqual([]);
        }
    });

    it("refuses the removed policy-wide `decimals` with a migration message", () => {
        // Keeping it silently honoured would leave the mis-pricing hole open behind a
        // field that reads like a formatting detail.
        expect(() => buildSpendPolicy({ decimals: 18, maxPerCall: "$1" })).toThrow(/`decimals` is no longer supported/);
        expect(() => buildPaymentGuard({ decimals: 18, maxPerRun: "$1" }, createSpendState())).toThrow(/`decimals` is no longer supported/);
    });
});

describe("buildPaymentGuard", () => {
    it("aborts a payment in an asset outside the allowlist (X402-01, defence in depth)", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1" }, state);

        const result = await guard(guardContext(requirement({ amount: "10000", asset: OTHER_ASSET })));

        expect(result).toEqual({ abort: true, reason: expect.stringMatching(/not in this wallet's allowed assets/) });
        expect(state.spentAtomic).toBe(0n);
    });

    it("aborts on a non-canonical amount instead of throwing out of the hook", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1" }, state);

        const result = await guard(guardContext(requirement({ amount: "-1" })));

        expect(result).toEqual({ abort: true, reason: expect.stringMatching(/not a canonical atomic quantity/) });
        // Nothing reserved: the abort happens before the reservation.
        expect(state.spentAtomic).toBe(0n);
    });

    it("sums same-decimals assets across networks into one per-run ledger", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);

        // USDC on Base and USDC on Solana are both 6-decimal and dollar-pegged, so their
        // atomic amounts are directly comparable — a multi-network agent isn't penalised.
        await expect(guard(guardContext(requirement({ amount: "15000" })))).resolves.toBeUndefined();
        await expect(guard(guardContext(requirement({ amount: "4000", asset: USDC_SOLANA, network: SOLANA_MAINNET })))).resolves.toBeUndefined();
        expect(state.spentAtomic).toBe(19_000n);

        const third = await guard(guardContext(requirement({ amount: "2000", asset: USDC_SOLANA, network: SOLANA_MAINNET })));

        expect(third).toEqual({ abort: true, reason: expect.stringMatching(/per-run cap/) });
    });

    it("refuses to mix asset precisions under one per-run cap", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard(
            {
                allowedAssets: [
                    { asset: USDC_BASE, decimals: 6, network: "base" },
                    { asset: OTHER_ASSET, decimals: 18, network: "base" },
                ],
                maxPerRun: "$100",
            },
            state,
        );

        await expect(guard(guardContext(requirement({ amount: "10000" })))).resolves.toBeUndefined();

        // 18-decimal units in the same scalar ledger as 6-decimal units would make the
        // running total meaningless, so the run stays locked to the precision it started in.
        const mixed = await guard(guardContext(requirement({ amount: (10n ** 18n).toString(), asset: OTHER_ASSET })));

        expect(mixed).toEqual({ abort: true, reason: expect.stringMatching(/cannot mix asset precisions/) });
        expect(state.spentAtomic).toBe(10_000n);
    });

    it("scales the per-run cap by the run's asset decimals", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ allowedAssets: [{ asset: OTHER_ASSET, decimals: 18, network: "base" }], maxPerRun: "$2" }, state);

        await expect(guard(guardContext(requirement({ amount: (10n ** 18n).toString(), asset: OTHER_ASSET })))).resolves.toBeUndefined();
        expect(state.spentAtomic).toBe(10n ** 18n);

        const over = await guard(guardContext(requirement({ amount: (10n ** 18n + 1n).toString(), asset: OTHER_ASSET })));

        expect(over).toEqual({ abort: true, reason: expect.stringMatching(/per-run cap/) });
    });

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

    it("aborts when the confirmation gate returns a truthy non-boolean", async () => {
        // A confirmation hook returning its UI result (`{ confirmed: false }`, a
        // dialog handle) is not an approval. `onPaymentRequired`'s mere presence
        // also satisfies the "bounded spend policy" check, so treating a truthy
        // non-`true` as approval would auto-approve every payment on a wallet whose
        // owner believes it is gated.
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1", onPaymentRequired: () => ({ confirmed: false }) as unknown as boolean }, state);

        const result = await guard(guardContext(requirement()));

        expect(result).toEqual({ abort: true, reason: expect.stringMatching(/declined by onPaymentRequired/) });
        expect(state.spentAtomic).toBe(0n);
    });

    it("proceeds when the confirmation gate approves, keeping the reservation", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1", onPaymentRequired: () => true }, state);

        await expect(guard(guardContext(requirement({ amount: "10000" })))).resolves.toBeUndefined();
        expect(state.spentAtomic).toBe(10_000n);
    });

    it("releases its reservation and rethrows when the confirmation gate throws", async () => {
        const onPaymentRequired = vi.fn<(r: PaymentRequirements) => boolean>(() => {
            throw new Error("approval prompt timed out");
        });
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$1", onPaymentRequired }, state);

        // A throw (UI-prompt timeout, rejected remote-approval fetch) must propagate…
        await expect(guard(guardContext(requirement({ amount: "10000" })))).rejects.toThrow(/approval prompt timed out/);
        // …but never leave the reservation held: the spend returns to its pre-reservation baseline.
        expect(state.spentAtomic).toBe(0n);
    });

    it("a transient gate throw does not fail the run closed: a later payment under the same cap still succeeds", async () => {
        let calls = 0;
        const onPaymentRequired = vi.fn<(r: PaymentRequirements) => boolean>(() => {
            calls += 1;

            if (calls === 1) {
                throw new Error("transient approval failure");
            }

            return true;
        });
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02", onPaymentRequired }, state);

        await expect(guard(guardContext(requirement({ amount: "15000" })))).rejects.toThrow(/transient approval failure/);
        // Had the reservation leaked, this second 15000 would exceed the $0.02 (20000) cap.
        await expect(guard(guardContext(requirement({ amount: "15000" })))).resolves.toBeUndefined();
        expect(state.spentAtomic).toBe(15_000n);
    });

    it("does not under-count when a throwing gate is followed by onPaymentCreationFailure for the same amount", async () => {
        // @x402/core (v2) runs before-hooks *outside* the try/catch that fires
        // onPaymentCreationFailure, so a guard throw provably never triggers the
        // failure hook — but SpendState's release clamp keeps the ledger correct
        // even if a future rail did call both for one reservation.
        const state = createSpendState();
        const guard = buildPaymentGuard(
            {
                maxPerRun: "$1",
                onPaymentRequired: () => {
                    throw new Error("gate threw");
                },
            },
            state,
        );
        const release = releaseSpendOnFailure(state);

        await expect(guard(guardContext(requirement({ amount: "10000" })))).rejects.toThrow(/gate threw/);
        // The guard's catch already released the one reservation.
        expect(state.spentAtomic).toBe(0n);

        // A stray second release for the same amount must not drive the ledger below baseline.
        await release(failureContext(requirement({ amount: "10000" })));

        expect(state.spentAtomic).toBe(0n);
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

    it("releases nothing for a negative amount instead of inflating the ledger", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);
        const release = releaseSpendOnFailure(state);

        await guard(guardContext(requirement({ amount: "20000" })));

        expect(state.spentAtomic).toBe(20_000n);

        await expect(release(failureContext(requirement({ amount: "-1" })))).resolves.toBeUndefined();

        expect(state.spentAtomic).toBe(20_000n);
    });

    it("releases nothing for an unparsable amount instead of throwing", async () => {
        const state = createSpendState();
        const guard = buildPaymentGuard({ maxPerRun: "$0.02" }, state);
        const release = releaseSpendOnFailure(state);

        await guard(guardContext(requirement({ amount: "20000" })));

        expect(state.spentAtomic).toBe(20_000n);

        await expect(release(failureContext(requirement({ amount: "junk" })))).resolves.toBeUndefined();

        expect(state.spentAtomic).toBe(20_000n);
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
