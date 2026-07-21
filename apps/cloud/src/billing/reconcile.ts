/**
 * Overage-reconciliation glue (GAPS.md C3 follow-up). Wires the pure
 * `reconcileAllOverages` fleet driver to the control-plane D1: gathers each
 * org's plan + period usage + already-debited watermark, and builds the fleet
 * ports (watermark advance, exhaustion suspend, recovery un-suspend). The Creem
 * credits ledger + the schedule live in `server.ts` (this stays store-only, so
 * the mapping and the suspend/recover writes are testable against a fake store).
 */
import type { ControlPlaneDb } from "../deploy/sweeps";
import type { OverageFleetPorts, OverageOrgInput } from "./overage";
import type { PeriodUsage } from "./spend";

interface OrgRow {
    _id: string;
    creditsAccountId?: string;
    plan: string;
    suspendedReason?: string;
}

interface UsageRow {
    kind: string;
    organizationId: string;
    periodStart: number;
    quantity: number;
}

interface DebitRow {
    debitedCredits: number;
    organizationId: string;
    periodStart: number;
}

export interface OverageReconcileData {
    /** org id → its Creem credits-account id (null when none purchased yet). */
    accounts: Map<string, null | string>;
    inputs: OverageOrgInput[];
    /** org id → its current `suspendedReason` (for the recovery gate). */
    suspension: Map<string, string | undefined>;
}

/**
 * Read the fleet's reconciliation inputs for the period: per org, the plan,
 * the aggregated request/CPU usage, and the credits already debited (the
 * watermark). Also returns the account-id and suspension maps the ledger +
 * ports need.
 */
export const buildOverageReconcileData = async (database: ControlPlaneDb, periodStart: number): Promise<OverageReconcileData> => {
    const { page: organizationPage } = await database.findMany("organizations", {});
    const organizations = organizationPage as OrgRow[];

    const { page: usagePage } = await database.findMany("platformUsage", {});
    const usageByOrg = new Map<string, PeriodUsage>();

    for (const row of usagePage as UsageRow[]) {
        if (row.periodStart !== periodStart || (row.kind !== "requests" && row.kind !== "cpuMs")) {
            continue;
        }

        const bucket = usageByOrg.get(row.organizationId) ?? { cpuMs: 0, requests: 0 };

        bucket[row.kind] += row.quantity;
        usageByOrg.set(row.organizationId, bucket);
    }

    const { page: debitPage } = await database.findMany("overageDebits", {});
    const debitedByOrg = new Map<string, number>();

    for (const row of debitPage as DebitRow[]) {
        if (row.periodStart === periodStart) {
            debitedByOrg.set(row.organizationId, row.debitedCredits);
        }
    }

    const accounts = new Map<string, null | string>();
    const suspension = new Map<string, string | undefined>();
    const inputs: OverageOrgInput[] = [];

    for (const organization of organizations) {
        accounts.set(organization._id, organization.creditsAccountId ?? null);
        suspension.set(organization._id, organization.suspendedReason);
        inputs.push({
            alreadyDebitedCredits: debitedByOrg.get(organization._id) ?? 0,
            organizationId: organization._id,
            periodStart,
            plan: organization.plan,
            usage: usageByOrg.get(organization._id) ?? { cpuMs: 0, requests: 0 },
        });
    }

    return { accounts, inputs, suspension };
};

/**
 * The fleet ports over the control-plane store: advance the `overageDebits`
 * watermark (forward-only), suspend an exhausted org (`suspendedReason:
 * "overage"`, audited), and lift only *overage* suspensions on recovery. `now`
 * timestamps the writes; `suspension` gates the recovery so a spend-cap/dunning
 * suspension is never lifted here.
 */
export const overageFleetPorts = (
    database: ControlPlaneDb,
    ledger: OverageFleetPorts["ledger"],
    now: number,
    suspension: Map<string, string | undefined>,
): OverageFleetPorts => ({
    advanceWatermark: async (organizationId, periodStart, debitedCredits) => {
        const { page } = await database.findMany("overageDebits", { where: { organizationId, periodStart } });
        const existing = (page as DebitRow[])[0] as (DebitRow & { _id: string }) | undefined;

        if (!existing) {
            await database.insert("overageDebits", { debitedCredits, organizationId, periodStart, updatedAt: now });
        } else if (debitedCredits > existing.debitedCredits) {
            await database.patch(existing._id, { debitedCredits, updatedAt: now }, "overageDebits");
        }
    },
    ledger,
    onExhausted: async (organizationId) => {
        if (suspension.get(organizationId) !== undefined) {
            return; // already suspended (by any mechanism) — don't override the reason
        }

        await database.patch(organizationId, { suspendedAt: now, suspendedReason: "overage" }, "organizations");
        await database.insert("auditLog", {
            action: "organization.suspend",
            actorUserId: "system:overage",
            createdAt: now,
            organizationId,
            target: "prepaid credit balance exhausted",
        });
    },
    onRecovered: async (organizationId) => {
        // Only lift our own suspensions — dunning/spend-cap/support ones stay.
        if (suspension.get(organizationId) !== "overage") {
            return;
        }

        await database.patch(organizationId, { suspendedAt: undefined, suspendedReason: undefined }, "organizations");
        await database.insert("auditLog", {
            action: "organization.unsuspend",
            actorUserId: "system:overage",
            createdAt: now,
            organizationId,
            target: "prepaid credit balance restored",
        });
    },
});
