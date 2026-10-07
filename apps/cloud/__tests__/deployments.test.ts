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
    const live: Row = { _id: "d1", createdAt: 2, kind: "production", organizationId: "org_1", projectId: "p1", scriptName: "app", status: "live" };
    const queryCtx = (organization: null | Row, world: { deployments?: Row[]; ledger?: Row[]; organizations?: Row[]; projects?: Row[] } = {}): QueryCtx => {
        const rows = [...(world.organizations ?? (organization === null ? [] : [{ _id: "org_1", ...organization }])), ...(world.projects ?? [])];
        const page = (all: Row[]) => Promise.resolve({ continueCursor: null, isDone: true, page: all });

        return {
            db: {
                aliasOwnership: { findMany: () => page(world.ledger ?? []) },
                deployments: { findMany: () => page(world.deployments ?? [live]) },
                get: (id: string) => Promise.resolve(rows.find((row) => row["_id"] === id) ?? null),
                subscriptions: { findMany: () => page([]) },
            },
            now: Date.now(),
        } as unknown as QueryCtx;
    };
    const facts = async (organization: null | Row, world: Parameters<typeof queryCtx>[1] = {}) =>
        planForScript.handler(queryCtx(organization, world), { scriptName: "app" });
    const plan = async (organization: null | Row, world: Parameters<typeof queryCtx>[1] = {}): Promise<string> => {
        const answer = await facts(organization, world);

        return answer.plan;
    };

    /**
     * Every release of an alias shares its script name, so the row the plan comes
     * from must be the one the alias's verified owner serves — never whichever
     * row a page happens to start with.
     */
    describe("which deployment a script serves for", () => {
        const serving = { plan: "free" };
        const suspended = { _id: "org_old", plan: "free", suspendedAt: 1 };

        it("answers unknown for a script no standing release serves, instead of a default tier", async () => {
            await expect(plan(serving, { deployments: [] })).resolves.toBe("unknown");
            await expect(plan(serving, { deployments: [{ ...live, status: "destroyed" }] })).resolves.toBe("unknown");
        });

        it("reads the alias's ledger owner, not another organization's leftover row", async () => {
            const leftover = { ...live, _id: "d0", createdAt: 1, organizationId: "org_old", status: "destroyed" };

            await expect(
                plan(null, {
                    deployments: [leftover, live],
                    ledger: [{ alias: "app", organizationId: "org_1" }],
                    organizations: [{ _id: "org_1", plan: "free" }, suspended],
                }),
            ).resolves.toBe("free");
        });

        it("refuses when the ledger owner has no release here", async () => {
            await expect(plan(serving, { ledger: [{ alias: "app", organizationId: "org_other" }] })).resolves.toBe("unknown");
        });

        it("refuses a script whose standing releases belong to two organizations", async () => {
            await expect(
                plan(null, {
                    deployments: [live, { ...live, _id: "d2", organizationId: "org_old", status: "superseded" }],
                    organizations: [{ _id: "org_1", plan: "free" }, suspended],
                }),
            ).resolves.toBe("unknown");
        });

        it("takes the live release's protection, not an older one's", async () => {
            const preview = { ...live, _id: "d3", kind: "preview" };

            await expect(
                facts(serving, {
                    deployments: [{ ...live, createdAt: 9, kind: "production", status: "superseded" }, preview],
                    projects: [{ _id: "p1", previewPasswordHash: "h" }],
                }),
            ).resolves.toStrictEqual({ plan: "free", protected: true });
        });
    });

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
