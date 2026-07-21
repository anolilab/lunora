import { describe, expect, it, vi } from "vitest";

import type { CreditsLedgerPort, OverageFleetPorts, OverageOrgInput } from "../src/billing/overage";
import { includedUsageFor, overageCreditsOwed, planOverageDebit, reconcileAllOverages, reconcileOverage } from "../src/billing/overage";

/** Prepaid-credits overage billing on Creem (GAPS.md C3 follow-up). */

describe(overageCreditsOwed, () => {
    it("owes nothing inside the included quota", () => {
        expect(overageCreditsOwed("pro", { cpuMs: 30_000_000, requests: 10_000_000 })).toBe(0);
        expect(overageCreditsOwed("free", { cpuMs: 0, requests: 0 })).toBe(0);
    });

    it("prices usage beyond the quota at the overage rates", () => {
        // pro includes 10M requests; 11M → 1M over at $1.00/M = 100 credits.
        expect(overageCreditsOwed("pro", { cpuMs: 0, requests: 11_000_000 })).toBe(100);
        // pro includes 30M cpu-ms; 40M → 10M over at $0.10/M = 100 credits.
        expect(overageCreditsOwed("pro", { cpuMs: 40_000_000, requests: 0 })).toBe(100);
    });

    it("gives unknown plans the free allowance, never unlimited", () => {
        expect(includedUsageFor("mystery")).toStrictEqual(includedUsageFor("free"));
        expect(overageCreditsOwed("mystery", { cpuMs: 0, requests: 2_000_000 })).toBeGreaterThan(0);
    });
});

describe(planOverageDebit, () => {
    const base = { organizationId: "org_1", periodStart: 1000, plan: "pro" as const };

    it("plans the delta between owed and already-debited, with a watermark reference", () => {
        const plan = planOverageDebit({ ...base, alreadyDebitedCredits: 40, usage: { cpuMs: 0, requests: 11_000_000 } });

        expect(plan).toStrictEqual({ debitCredits: 60, owedCredits: 100, reference: "overage:org_1:1000:100" });
    });

    it("is a no-op when nothing new is owed (idempotent re-runs)", () => {
        expect(planOverageDebit({ ...base, alreadyDebitedCredits: 100, usage: { cpuMs: 0, requests: 11_000_000 } })).toBeNull();
        expect(planOverageDebit({ ...base, alreadyDebitedCredits: 0, usage: { cpuMs: 0, requests: 1_000_000 } })).toBeNull();
    });

    it("re-issues the SAME reference for the same watermark after a crash-retry", () => {
        const first = planOverageDebit({ ...base, alreadyDebitedCredits: 0, usage: { cpuMs: 0, requests: 11_000_000 } });
        const retry = planOverageDebit({ ...base, alreadyDebitedCredits: 0, usage: { cpuMs: 0, requests: 11_000_000 } });

        expect(first?.reference).toBe(retry?.reference);
    });
});

describe(reconcileOverage, () => {
    const input = { alreadyDebitedCredits: 0, organizationId: "org_1", periodStart: 1000, plan: "pro", usage: { cpuMs: 0, requests: 11_000_000 } };

    const ledgerWith = (balance: null | number): { debits: string[]; ledger: CreditsLedgerPort } => {
        const debits: string[] = [];

        return {
            debits,
            ledger: {
                balance: () => Promise.resolve(balance),
                debit: (_org, credits, reference) => {
                    debits.push(`${String(credits)}@${reference}`);

                    return Promise.resolve();
                },
            },
        };
    };

    it("debits when the prepaid balance covers the delta", async () => {
        const { debits, ledger } = ledgerWith(500);

        await expect(reconcileOverage(input, ledger)).resolves.toStrictEqual({ credits: 100, status: "debited" });
        expect(debits).toStrictEqual(["100@overage:org_1:1000:100"]);
    });

    it("reports exhausted (never debits, never goes negative) when the balance falls short", async () => {
        const { debits, ledger } = ledgerWith(50);

        await expect(reconcileOverage(input, ledger)).resolves.toStrictEqual({ status: "exhausted" });
        expect(debits).toStrictEqual([]);
    });

    it("treats a missing credits account with owed overage as exhausted", async () => {
        const { ledger } = ledgerWith(null);

        await expect(reconcileOverage(input, ledger)).resolves.toStrictEqual({ status: "exhausted" });
    });

    it("skips the balance read entirely when nothing is owed", async () => {
        const ledger: CreditsLedgerPort = {
            balance: () => Promise.reject(new Error("must not be called")),
            debit: () => Promise.reject(new Error("must not be called")),
        };

        await expect(reconcileOverage({ ...input, usage: { cpuMs: 0, requests: 1 } }, ledger)).resolves.toStrictEqual({ status: "none" });
    });
});

describe(reconcileAllOverages, () => {
    const org = (id: string, requests: number, alreadyDebitedCredits = 0): OverageOrgInput => ({
        alreadyDebitedCredits,
        organizationId: id,
        periodStart: 500,
        plan: "pro",
        usage: { cpuMs: 0, requests },
    });

    const ports = (balance: null | number, over: Partial<OverageFleetPorts> = {}): OverageFleetPorts => ({
        advanceWatermark: () => Promise.resolve(),
        ledger: { balance: () => Promise.resolve(balance), debit: () => Promise.resolve() },
        onExhausted: () => Promise.resolve(),
        onRecovered: () => Promise.resolve(),
        ...over,
    });

    it("fires onRecovered after a successful debit (self-heal: covered org un-suspended)", async () => {
        const onRecovered = vi.fn(() => Promise.resolve());
        // 11M requests on pro (10M included) → 100 credits owed; balance covers it.
        const summary = await reconcileAllOverages([org("org_a", 11_000_000)], ports(500, { onRecovered }));

        expect(summary).toStrictEqual({ debitedCredits: 100, debitedOrgs: 1, exhausted: 0 });
        expect(onRecovered).toHaveBeenCalledWith("org_a");
    });

    it("fires onRecovered when nothing is owed (org in good standing)", async () => {
        const onRecovered = vi.fn(() => Promise.resolve());
        const onExhausted = vi.fn(() => Promise.resolve());
        await reconcileAllOverages([org("org_a", 1)], ports(0, { onExhausted, onRecovered }));

        expect(onRecovered).toHaveBeenCalledWith("org_a");
        expect(onExhausted).not.toHaveBeenCalled();
    });

    it("suspends (not recovers) when the balance can't cover the owed overage", async () => {
        const onRecovered = vi.fn(() => Promise.resolve());
        const onExhausted = vi.fn(() => Promise.resolve());
        const summary = await reconcileAllOverages([org("org_a", 11_000_000)], ports(50, { onExhausted, onRecovered }));

        expect(summary.exhausted).toBe(1);
        expect(onExhausted).toHaveBeenCalledWith("org_a");
        expect(onRecovered).not.toHaveBeenCalled();
    });
});
