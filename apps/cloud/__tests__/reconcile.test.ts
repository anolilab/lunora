import { describe, expect, it, vi } from "vitest";

import type { CreditsLedgerPort } from "../src/billing/overage";
import { buildOverageReconcileData, overageFleetPorts } from "../src/billing/reconcile";
import type { ControlPlaneDatabase } from "../src/store";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

const noopLedger: CreditsLedgerPort = { balance: () => Promise.resolve(0), debit: () => Promise.resolve() };

describe(buildOverageReconcileData, () => {
    it("aggregates period usage per org and joins plan + watermark + account", async () => {
        const database = fakeControlPlaneDb({
            organizations: [
                { _id: "org_a", creditsAccountId: "acct_a", plan: "pro" },
                { _id: "org_b", plan: "free" },
            ],
            overageDebits: [{ debitedCredits: 40, organizationId: "org_a", periodStart: 500 }],
            platformUsage: [
                { kind: "requests", organizationId: "org_a", periodStart: 500, quantity: 12 },
                { kind: "cpuMs", organizationId: "org_a", periodStart: 500, quantity: 7 },
                { kind: "requests", organizationId: "org_a", periodStart: 499, quantity: 999 }, // other period → ignored
                // A real meter, but not one the overage rate card prices — the
                // cap counts it, credits never do. See `buildOverageReconcileData`.
                { kind: "r2StorageGbMonths", organizationId: "org_a", periodStart: 500, quantity: 5 },
            ],
        });

        const { accounts, inputs, suspension } = await buildOverageReconcileData(database, 500);

        expect(inputs).toContainEqual({ alreadyDebitedCredits: 40, organizationId: "org_a", periodStart: 500, plan: "pro", usage: { cpuMs: 7, requests: 12 } });
        // org_b has no usage/debits → zeroed input.
        expect(inputs).toContainEqual({ alreadyDebitedCredits: 0, organizationId: "org_b", periodStart: 500, plan: "free", usage: { cpuMs: 0, requests: 0 } });
        expect(accounts.get("org_a")).toBe("acct_a");
        expect(accounts.get("org_b")).toBeNull();
        expect(suspension.get("org_a")).toBeUndefined();
    });
});

describe(overageFleetPorts, () => {
    it("inserts a fresh watermark, and advances an existing one only forward", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb(
            { overageDebits: [{ _id: "w1", debitedCredits: 30, organizationId: "org_a", periodStart: 500 }] },
            { insert, patch },
        );

        const ports = overageFleetPorts(database, noopLedger, 1000, new Map());

        // org_a already at 30 → advancing to 50 patches forward.
        await ports.advanceWatermark("org_a", 500, 50);

        expect(patch).toHaveBeenCalledWith("w1", { debitedCredits: 50, updatedAt: 1000 }, "overageDebits");

        // org_b has no row → insert.
        await ports.advanceWatermark("org_b", 500, 10);

        expect(insert).toHaveBeenCalledWith("overageDebits", { debitedCredits: 10, organizationId: "org_b", periodStart: 500, updatedAt: 1000 });
    });

    it("suspends an unsuspended exhausted org with reason 'overage' + audit", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const ports = overageFleetPorts(fakeControlPlaneDb({}, { insert, patch }), noopLedger, 1000, new Map([["org_a", undefined]]));

        await ports.onExhausted("org_a");

        expect(patch).toHaveBeenCalledWith("org_a", { suspendedAt: 1000, suspendedReason: "overage" }, "organizations");
        expect(insert).toHaveBeenCalledWith("auditLog", expect.objectContaining({ action: "organization.suspend", actorUserId: "system:overage" }));
    });

    it("never overrides a non-overage suspension on exhaustion", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const ports = overageFleetPorts(fakeControlPlaneDb({}, { patch }), noopLedger, 1000, new Map([["org_a", "dunning"]]));

        await ports.onExhausted("org_a");

        expect(patch).not.toHaveBeenCalled();
    });

    it("lifts only an overage suspension on recovery", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const ports = overageFleetPorts(
            fakeControlPlaneDb({}, { patch }),
            noopLedger,
            1000,
            new Map([
                ["org_dun", "dunning"],
                ["org_over", "overage"],
            ]),
        );

        await ports.onRecovered?.("org_over");

        expect(patch).toHaveBeenCalledWith("org_over", { suspendedAt: undefined, suspendedReason: undefined }, "organizations");

        patch.mockClear();
        await ports.onRecovered?.("org_dun"); // dunning suspension must stay

        expect(patch).not.toHaveBeenCalled();
    });
});
