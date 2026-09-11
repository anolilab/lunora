import { describe, expect, it } from "vitest";

import type { CreemCreditsClientLike } from "../src/billing/creem-credits";
import { applyCreditPurchase, createCreemCreditsLedger } from "../src/billing/creem-credits";
import type { OverageOrgInput } from "../src/billing/overage";
import { reconcileAllOverages } from "../src/billing/overage";

/** Creem credits-ledger adapter + fleet overage reconciliation (GAPS.md C3). */

const clientWith = (balance: string): { calls: string[]; client: CreemCreditsClientLike } => {
    const calls: string[] = [];

    return {
        calls,
        client: {
            customerCredits: {
                createAccount: (request) => {
                    calls.push(`create:${request.customerId}:${request.initialBalance ?? ""}`);

                    return Promise.resolve({ id: "acct_new" });
                },
                creditAccount: (id, request) => {
                    calls.push(`credit:${id}:${request.amount}:${request.reference}`);

                    return Promise.resolve({});
                },
                debitAccount: (id, request) => {
                    calls.push(`debit:${id}:${request.amount}:${request.reference}`);

                    return Promise.resolve({});
                },
                getAccountBalance: (id) => {
                    calls.push(`balance:${id}`);

                    return Promise.resolve({ balance });
                },
            },
        },
    };
};

describe(createCreemCreditsLedger, () => {
    it("reads balances through the resolved account and debits with the idempotent reference", async () => {
        const { calls, client } = clientWith("500");
        const ledger = createCreemCreditsLedger({ client, resolveAccountId: () => Promise.resolve("acct_1") });

        await expect(ledger.balance("org_1")).resolves.toBe(500);

        await ledger.debit("org_1", 100, "overage:org_1:1000:100");

        expect(calls).toStrictEqual(["balance:acct_1", "debit:acct_1:100:overage:org_1:1000:100"]);
    });

    it("resolves a missing account to a null balance and refuses to debit into it", async () => {
        const { client } = clientWith("500");
        const ledger = createCreemCreditsLedger({ client, resolveAccountId: () => Promise.resolve(null) });

        await expect(ledger.balance("org_1")).resolves.toBeNull();
        await expect(ledger.debit("org_1", 1, "r")).rejects.toThrow(/no credits account/u);
    });
});

describe(applyCreditPurchase, () => {
    it("creates the account seeded with the purchase on first buy", async () => {
        const { calls, client } = clientWith("0");
        const result = await applyCreditPurchase(client, { credits: 1000, customerId: "cust_1", reference: "pay_1" });

        expect(result).toStrictEqual({ accountId: "acct_new" });
        expect(calls).toStrictEqual(["create:cust_1:1000"]);
    });

    it("credits the existing account with the payment id as the idempotency reference", async () => {
        const { calls, client } = clientWith("0");
        const result = await applyCreditPurchase(client, { accountId: "acct_1", credits: 500, customerId: "cust_1", reference: "pay_2" });

        expect(result).toStrictEqual({ accountId: "acct_1" });
        expect(calls).toStrictEqual(["credit:acct_1:500:pay_2"]);
    });
});

describe(reconcileAllOverages, () => {
    const org = (id: string, requests: number, alreadyDebitedCredits = 0): OverageOrgInput => {
        return { alreadyDebitedCredits, organizationId: id, periodStart: 1000, plan: "pro", usage: { cpuMs: 0, requests } };
    };

    it("debits owing orgs, advances watermarks, suspends the exhausted, skips the rest", async () => {
        const watermarks: string[] = [];
        const suspended: string[] = [];
        const balances: Record<string, null | number> = { org_a: 500, org_b: 10, org_c: 500 };

        const summary = await reconcileAllOverages(
            // a owes 100, b owes 100 (balance 10 → exhausted), c owes nothing.
            [org("org_a", 11_000_000), org("org_b", 11_000_000), org("org_c", 1_000_000)],
            {
                advanceWatermark: (id, periodStart, credits) => {
                    watermarks.push(`${id}:${String(periodStart)}:${String(credits)}`);

                    return Promise.resolve();
                },
                ledger: {
                    balance: (id) => Promise.resolve(balances[id] ?? null),
                    debit: () => Promise.resolve(),
                },
                onExhausted: (id) => {
                    suspended.push(id);

                    return Promise.resolve();
                },
            },
        );

        expect(summary).toStrictEqual({ debitedCredits: 100, debitedOrgs: 1, exhausted: 1 });
        expect(watermarks).toStrictEqual(["org_a:1000:100"]);
        expect(suspended).toStrictEqual(["org_b"]);
    });

    it("isolates one org's provider failure — the fleet keeps going; the failed org under-bills, never double-bills", async () => {
        const watermarks: string[] = [];
        const summary = await reconcileAllOverages([org("org_a", 11_000_000), org("org_b", 11_000_000)], {
            advanceWatermark: (id, periodStart, credits) => {
                watermarks.push(`${id}:${String(periodStart)}:${String(credits)}`);

                return Promise.resolve();
            },
            ledger: {
                balance: () => Promise.resolve(500),
                debit: (id) => (id === "org_a" ? Promise.reject(new Error("creem 500")) : Promise.resolve()),
            },
            onExhausted: () => Promise.resolve(),
        });

        // org_a's debit throws → only org_b counts toward the summary.
        expect(summary).toStrictEqual({ debitedCredits: 100, debitedOrgs: 1, exhausted: 0 });
        // The watermark is advanced BEFORE the debit (fail-safe ordering), so both
        // orgs' watermarks moved — org_a's failed debit means it is *under*-billed
        // for this delta, never charged twice on a retry after usage grows.
        expect(watermarks).toStrictEqual(["org_a:1000:100", "org_b:1000:100"]);
    });
});
