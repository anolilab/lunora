import { describe, expect, it } from "vitest";

import type { MutationCtx, QueryCtx } from "../lunora/_generated/server";
import { cleanupExpiredPreviews, planForScript } from "../lunora/deployments";
import { periodStartOf } from "../src/billing/spend";

type Row = Record<string, unknown>;

/** Fake mutation ctx: a `deployments.findMany` over in-memory rows + a recording `patch`. */
const makeCtx = (rows: Row[]): { ctx: MutationCtx; patched: { id: string; patch: Row }[] } => {
    const patched: { id: string; patch: Row }[] = [];

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: null },
        // Handlers read the clock through `ctx.now` (deterministic under OCC retry),
        // so the double has to supply it — `Date.now()` is no longer reachable there.
        now: Date.now(),
        db: {
            deployments: {
                findMany: (args?: { where?: Row }) => {
                    const where = args?.where ?? {};
                    const page = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

                    return Promise.resolve({ page });
                },
            },
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
        },
        log: {},
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, patched };
};

describe("deployments.cleanupExpiredPreviews", () => {
    it("destroys only expired, not-yet-destroyed previews", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([
            { _id: "live_expired", expiresAt: now - 1000, kind: "preview", status: "live" },
            { _id: "queued_expired", expiresAt: now - 1, kind: "preview", status: "queued" },
            { _id: "not_expired", expiresAt: now + 100_000, kind: "preview", status: "live" },
            { _id: "already_destroyed", expiresAt: now - 1000, kind: "preview", status: "destroyed" },
            { _id: "no_expiry", kind: "preview", status: "live" },
        ]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 2 });
        expect(patched.map((entry) => entry.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["live_expired", "queued_expired"]);
        expect(patched.every((entry) => entry.patch["status"] === "destroyed")).toBe(true);
    });

    it("is a no-op when nothing is expired", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([{ _id: "fresh", expiresAt: now + 100_000, kind: "preview", status: "live" }]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 0 });
        expect(patched).toHaveLength(0);
    });
});

/**
 * The dispatcher's admission check (plan 365 W3). The org row is read once and
 * carries both the cron's suspension and the running accrual's breach bit.
 */
describe("deployments.planForScript", () => {
    const period = periodStartOf(Date.now());
    const queryCtx = (organization: null | Row): QueryCtx =>
        ({
            db: {
                deployments: { findMany: () => Promise.resolve({ page: [{ _id: "d1", kind: "production", organizationId: "org_1", scriptName: "app" }] }) },
                get: () => Promise.resolve(organization),
                subscriptions: { findMany: () => Promise.resolve({ page: [] }) },
            },
            now: Date.now(),
        }) as unknown as QueryCtx;
    const plan = async (organization: null | Row): Promise<string> => {
        const facts = await planForScript.handler(queryCtx(organization), { scriptName: "app" });

        return facts.plan;
    };

    it("serves an org under its cap", async () => {
        await expect(plan({ _id: "org_1", plan: "free", spendNanoCents: 1e9, spendPeriod: period })).resolves.toBe("free");
    });

    it("refuses an org the cron suspended", async () => {
        await expect(plan({ _id: "org_1", plan: "free", suspendedAt: 1 })).resolves.toBe("suspended");
    });

    it("refuses an org whose running spend breaches its cap before the cron has run", async () => {
        // free cap is 500 cents; 600 cents of accrual this period.
        await expect(plan({ _id: "org_1", plan: "free", spendNanoCents: 600e9, spendPeriod: period })).resolves.toBe("suspended");
    });

    it("ignores last period's accrual", async () => {
        await expect(plan({ _id: "org_1", plan: "free", spendNanoCents: 600e9, spendPeriod: period - 1 })).resolves.toBe("free");
    });

    it("honours a support-raised cap", async () => {
        await expect(plan({ _id: "org_1", plan: "free", spendCapMinor: 0, spendNanoCents: 600e9, spendPeriod: period })).resolves.toBe("free");
    });

    /** Unknown state fails closed: a deployment whose org row is gone is not served. */
    it("refuses a deployment whose organization row is missing", async () => {
        await expect(plan(null)).resolves.toBe("suspended");
    });
});
