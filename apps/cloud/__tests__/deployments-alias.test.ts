import { describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { claimAlias } from "../lunora/deployments";

type AliasRow = { _id: string; alias: string; organizationId: string; projectId: string };

/**
 * Fake mutation ctx backing `aliasOwnership` with an in-memory array. `insert`
 * can be told to throw (simulating a lost `by_alias` unique-index race) and, in
 * that case, to first land a concurrent `winner` row so the helper's catch-path
 * re-read observes the race outcome.
 */
const makeCtx = (
    initial: AliasRow[],
    insertBehavior?: { throw?: Error; winner?: AliasRow },
): { ctx: MutationCtx; inserts: { row: Record<string, unknown>; table: string }[]; store: AliasRow[] } => {
    const store = [...initial];
    const inserts: { row: Record<string, unknown>; table: string }[] = [];

    const ctx = {
        // `claimAlias` stamps `createdAt: ctx.now`; without it the ledger row
        // would be written with an undefined timestamp.
        now: Date.now(),
        db: {
            aliasOwnership: {
                findMany: ({ where }: { where: { alias: string } }) => Promise.resolve({ page: store.filter((row) => row.alias === where.alias) }),
            },
            insert: vi.fn((table: string, row: Record<string, unknown>) => {
                inserts.push({ row, table });

                if (insertBehavior?.throw) {
                    if (insertBehavior.winner) {
                        store.push(insertBehavior.winner);
                    }

                    return Promise.reject(insertBehavior.throw);
                }

                const id = `ao_${String(store.length)}`;

                store.push({ _id: id, ...(row as Omit<AliasRow, "_id">) });

                return Promise.resolve(id);
            }),
        },
    } as unknown as MutationCtx;

    return { ctx, inserts, store };
};

const org = "org_1" as never;

describe(claimAlias, () => {
    it("claims an unowned alias by inserting an ownership row", async () => {
        const { ctx, inserts } = makeCtx([]);

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).resolves.toBeUndefined();
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toMatchObject({ row: { alias: "acme", projectId: "proj_A" }, table: "aliasOwnership" });
    });

    it("is idempotent when the alias is already owned by the same project", async () => {
        const { ctx, inserts } = makeCtx([{ _id: "ao_0", alias: "acme", organizationId: "org_1", projectId: "proj_A" }]);

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).resolves.toBeUndefined();
        expect(inserts).toHaveLength(0);
    });

    it("rejects an alias already owned by another project", async () => {
        const { ctx, inserts } = makeCtx([{ _id: "ao_0", alias: "acme", organizationId: "org_2", projectId: "proj_B" }]);

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(inserts).toHaveLength(0);
    });

    it("resolves when a concurrent race is won by our own project", async () => {
        // First read sees no owner; our insert loses the unique-index race, but the
        // winner is us (same project racing itself), so the claim stands.
        const { ctx } = makeCtx([], {
            throw: new Error("UNIQUE constraint failed"),
            winner: { _id: "ao_win", alias: "acme", organizationId: "org_1", projectId: "proj_A" },
        });

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).resolves.toBeUndefined();
    });

    it("rejects when a concurrent race is won by another project", async () => {
        const { ctx } = makeCtx([], {
            throw: new Error("UNIQUE constraint failed"),
            winner: { _id: "ao_win", alias: "acme", organizationId: "org_2", projectId: "proj_B" },
        });

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("re-throws a non-ownership insert failure (no winner appeared)", async () => {
        const boom = new Error("d1 unavailable");
        const { ctx } = makeCtx([], { throw: boom });

        await expect(claimAlias(ctx, "acme", org, "proj_A" as never)).rejects.toBe(boom);
    });
});
