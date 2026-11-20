import { describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { claimAlias } from "../lunora/deployment-aliases";
import { create as createDeployment } from "../lunora/deployments";
import { ALIAS_RECLAIM_COOLDOWN_MS } from "../src/plans/plan-resolver";
import { makeCtx as makeFullCtx, owner } from "./_helpers/fake-ctx";

type AliasRow = { _id: string; alias: string; organizationId: string; projectId: string }; // gitleaks:allow -- a type alias; the scanner matches `projectId` as a Cypress id

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
            deployments: { findMany: () => Promise.resolve({ page: [] }) },
            insert: vi.fn<(table: string, row: Record<string, unknown>) => Promise<unknown>>((table, row) => {
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

describe("deployments.create while the alias is torn down", () => {
    const NOW = 1_700_000_000_000;
    const release = (teardownAt?: number) => {
        const full = makeFullCtx(
            {
                aliasOwnership: [
                    { _id: "ao_1", alias: "web", organizationId: "org_1", projectId: "prj_1", ...(teardownAt === undefined ? {} : { teardownAt }) },
                ],
                deployments: [],
                halts: [],
                members: [owner("org_1")],
                organizations: [{ _id: "org_1" }],
                projects: [{ _id: "prj_1", organizationId: "org_1", slug: "web" }],
            },
            { now: NOW },
        );

        return {
            ...full,
            created: createDeployment.handler(full.ctx, { kind: "preview", organizationId: "org_1" as never, projectId: "prj_1" as never, scriptName: "web" }),
        };
    };

    it("refuses the release and removes the row it inserted while the teardown sweep holds the alias", async () => {
        expect.assertions(2);

        const { created, ops } = release(NOW - 60_000);

        await expect(created).rejects.toMatchObject({ code: "CONFLICT" });
        expect(ops.filter((op) => op.kind === "delete")).toStrictEqual([{ id: "deployments_new", kind: "delete" }]);
    });

    it("creates the release when the hold is cleared, or stale from a sweep that died", async () => {
        expect.assertions(2);

        await expect(release().created).resolves.toMatchObject({ deploymentId: "deployments_new" });
        await expect(release(NOW - 31 * 60_000).created).resolves.toMatchObject({ deploymentId: "deployments_new" });
    });
});

describe("deployments.create onto an alias another project released", () => {
    const NOW = 1_700_000_000_000;
    const reclaim = (releasedAt: number) => {
        const full = makeFullCtx(
            {
                aliasOwnership: [],
                // The previous owner's torn-down preview: a dispatcher that read its plan answer may serve it until the cooldown ends.
                deployments: [
                    {
                        _id: "dep_old",
                        kind: "preview",
                        organizationId: "org_2",
                        projectId: "prj_2",
                        scriptName: "web",
                        status: "destroyed",
                        updatedAt: releasedAt,
                    },
                ],
                halts: [],
                members: [owner("org_1")],
                organizations: [{ _id: "org_1" }],
                projects: [{ _id: "prj_1", organizationId: "org_1", slug: "site" }],
            },
            { now: NOW },
        );

        return createDeployment.handler(full.ctx, { kind: "preview", organizationId: "org_1" as never, projectId: "prj_1" as never, scriptName: "web" });
    };

    it("refuses the claim while a dispatcher may still serve the previous owner's plan answer", async () => {
        expect.assertions(1);

        await expect(reclaim(NOW - ALIAS_RECLAIM_COOLDOWN_MS + 1000)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("claims the alias once every cached answer for the previous owner has expired", async () => {
        expect.assertions(1);

        await expect(reclaim(NOW - ALIAS_RECLAIM_COOLDOWN_MS)).resolves.toMatchObject({ deploymentId: "deployments_new" });
    });
});

describe("deployments.create onto a production alias", () => {
    const NOW = 1_700_000_000_000;
    const deploy = (
        kind: "dev" | "preview" | "production",
        scriptName: string,
        project: Record<string, unknown> = {},
        deployments: Record<string, unknown>[] = [],
    ) => {
        const { ctx } = makeFullCtx(
            {
                aliasOwnership: [
                    { _id: "ao_1", alias: "web", organizationId: "org_1", projectId: "prj_1" },
                    { _id: "ao_2", alias: "web-pr-feat-x", organizationId: "org_1", projectId: "prj_1" },
                ],
                deployments,
                halts: [],
                members: [owner("org_1")],
                organizations: [{ _id: "org_1" }],
                projects: [{ _id: "prj_1", organizationId: "org_1", slug: "web", ...project }],
            },
            { now: NOW },
        );

        return createDeployment.handler(ctx, { kind, organizationId: "org_1" as never, projectId: "prj_1" as never, scriptName });
    };

    it("refuses a preview or dev release onto the project's reserved production alias", async () => {
        expect.assertions(2);

        await expect(deploy("preview", "web", { productionAlias: "web" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(deploy("dev", "web", { productionAlias: "web" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a preview release onto an alias a production release runs on", async () => {
        expect.assertions(1);

        const live = {
            _id: "dep_1",
            createdAt: NOW - 1,
            kind: "production",
            organizationId: "org_1",
            projectId: "prj_1",
            scriptName: "web",
            status: "live",
            version: 1,
        };

        await expect(deploy("preview", "web", {}, [live])).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("still records a production release on the production alias and a preview on its own", async () => {
        expect.assertions(2);

        await expect(deploy("production", "web", { productionAlias: "web" })).resolves.toMatchObject({ deploymentId: "deployments_new" });
        await expect(deploy("preview", "web-pr-feat-x", { productionAlias: "web" })).resolves.toMatchObject({ deploymentId: "deployments_new" });
    });
});
