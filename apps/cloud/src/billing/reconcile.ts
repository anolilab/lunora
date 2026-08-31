/**
 * Overage-reconciliation glue (GAPS.md C3 follow-up). Wires the pure
 * `reconcileAllOverages` fleet driver to the control-plane D1: gathers each
 * org's plan + period usage + already-debited watermark, and builds the fleet
 * ports (watermark advance, exhaustion suspend, recovery un-suspend). The Creem
 * credits ledger + the schedule live in `server.ts` (this stays store-only, so
 * the mapping and the suspend/recover writes are testable against a fake store).
 */
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
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
export const buildOverageReconcileData = async (database: ControlPlaneDatabase, periodStart: number): Promise<OverageReconcileData> => {
    // Drained, not single-paged. This is the money path: `findMany` answers one
    // 1000-row page, so the previous reads silently evaluated an arbitrary slice
    // of the fleet — orgs past the boundary were never debited, never suspended
    // when their credits ran out, never un-suspended when topped up, and the sweep
    // reported success either way. `platformUsage` crosses 1000 rows quickly,
    // because `rollup` only compacts CLOSED periods, so the truncation bit the
    // current period first. The identical bug was already fixed in
    // `lunora/usage.ts`'s spend-cap sweep; `src/` just had no way to express it.
    const organizations = await drainTable<OrgRow>(database, "organizations");

    // The period filter belongs in the QUERY — filtering it in JS after a bounded
    // read is the second half of the same bug, since rows from other periods
    // consumed the budget that this period's rows needed.
    const usageRows = await drainTable<UsageRow>(database, "platformUsage", { where: { periodStart } });
    const usageByOrg = new Map<string, PeriodUsage>();

    // Only the customer-priced meters are folded in: `overageCreditsOwed` bills
    // requests + CPU, so summing storage or DO duration here would put usage in
    // the bucket that no rate ever converts into credits. The *cap* prices the
    // whole bill (`src/billing/spend.ts`) — that asymmetry is deliberate.
    for (const row of usageRows) {
        if (row.kind !== "requests" && row.kind !== "cpuMs") {
            continue;
        }

        const bucket = usageByOrg.get(row.organizationId) ?? { cpuMs: 0, requests: 0 };

        bucket[row.kind] = (bucket[row.kind] ?? 0) + row.quantity;
        usageByOrg.set(row.organizationId, bucket);
    }

    const debitRows = await drainTable<DebitRow>(database, "overageDebits", { where: { periodStart } });
    const debitedByOrg = new Map<string, number>();

    for (const row of debitRows) {
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
    database: ControlPlaneDatabase,
    ledger: OverageFleetPorts["ledger"],
    now: number,
    suspension: Map<string, string | undefined>,
): OverageFleetPorts => {
    return {
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
    };
};
