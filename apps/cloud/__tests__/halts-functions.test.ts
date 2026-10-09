import { describe, expect, it } from "vitest";

import { create, releaseTarget, rollback } from "../lunora/deployments";
import { aliasHalted, haltOrganization, operatorHalt, resumeOrganization, setHaltOnSuspension, status } from "../lunora/halts";
import { HALTED_REFUSAL } from "../src/deploy/halt";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * The emergency stop's Lunora functions (`lunora/halts.ts`) and the refusals
 * it adds to the release path (`lunora/deployments.ts`): who may stop, resume
 * and change the setting, what each writes, and that a halted project takes no
 * deploy, rollback or revert.
 */

const live = (id: string, alias: string, target: string, projectId: string): Row => {
    return { _id: id, alias, createdAt: 1, kind: "production", organizationId: "org_1", projectId, scriptName: alias, status: "live", target };
};

const tables = (overrides: Record<string, Row[]> = {}): Record<string, Row[]> => {
    return {
        deployments: [
            live("d_acme", "acme", "cloudflare-wfp", "p_acme"),
            live("d_shop", "shop", "cloudflare-workers", "p_shop"),
            live("d_edge", "edge", "celld-vps", "p_edge"),
        ],
        halts: [],
        members: [owner("org_1")],
        organizations: [{ _id: "org_1", name: "Acme" }],
        projects: [
            { _id: "p_acme", name: "Acme", organizationId: "org_1", slug: "acme" },
            { _id: "p_shop", name: "Shop", organizationId: "org_1", slug: "shop" },
        ],
        ...overrides,
    };
};

const halt = (alias: string, projectId: string, overrides: Row = {}): Row => {
    return {
        _id: `h_${alias}`,
        alias,
        createdAt: 5,
        haltedBy: "usr_1",
        kind: "production",
        organizationId: "org_1",
        projectId,
        reason: "manual",
        source: "manual",
        state: "halted",
        target: "cloudflare-wfp",
        updatedAt: 5,
        ...overrides,
    };
};

const inserted = (ops: ReturnType<typeof makeCtx>["ops"], table: string): Row[] =>
    ops.flatMap((op) => (op.kind === "insert" && op.table === table ? [op.document] : []));

describe("halts.haltOrganization", () => {
    it("asks an owner's stop for every live alias a halt reaches, audit-logged", async () => {
        const { ctx, ops } = makeCtx(tables());
        const result = await haltOrganization.handler(ctx, { organizationId: "org_1" } as never);

        expect(result.halted).toStrictEqual(["acme", "shop"]);
        expect(result.unsupported.map((entry) => entry.alias)).toStrictEqual(["edge"]);
        expect(inserted(ops, "halts").map((row) => [row["alias"], row["state"], row["source"], row["haltedBy"]])).toStrictEqual([
            ["acme", "halting", "manual", "usr_1"],
            ["shop", "halting", "manual", "usr_1"],
        ]);
        expect(inserted(ops, "auditLog").map((row) => row["action"])).toStrictEqual(["halt.requested"]);
    });

    it("refuses a plain member", async () => {
        const { ctx, ops } = makeCtx(tables({ members: [{ ...owner("org_1"), role: "member" }] }));

        await expect(haltOrganization.handler(ctx, { organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(inserted(ops, "halts")).toStrictEqual([]);
    });
});

describe("halts.resumeOrganization", () => {
    it("asks for every halted alias to resume", async () => {
        const { ctx, ops } = makeCtx(tables({ halts: [halt("acme", "p_acme"), halt("shop", "p_shop", { state: "halting" })] }));

        await expect(resumeOrganization.handler(ctx, { organizationId: "org_1" } as never)).resolves.toStrictEqual({ resumed: ["acme", "shop"] });
        expect(ops.filter((op) => op.kind === "patch").map((op) => (op.kind === "patch" ? op.patch["state"] : undefined))).toStrictEqual([
            "resuming",
            "resuming",
        ]);
    });

    it.each(["spend-cap", "overage"])("refuses while a %s suspension still halts the projects", async (reason) => {
        const { ctx } = makeCtx(tables({ halts: [halt("acme", "p_acme")], organizations: [{ _id: "org_1", suspendedAt: 1, suspendedReason: reason }] }));

        await expect(resumeOrganization.handler(ctx, { organizationId: "org_1" } as never)).rejects.toThrow(/stay halted until the suspension lifts/u);
    });

    it("allows it under a suspension the setting does not cover, or with the setting off", async () => {
        const dunning = makeCtx(tables({ halts: [halt("acme", "p_acme")], organizations: [{ _id: "org_1", suspendedAt: 1, suspendedReason: "dunning" }] }));
        const off = makeCtx(
            tables({
                halts: [halt("acme", "p_acme")],
                organizations: [{ _id: "org_1", haltOnSuspension: false, suspendedAt: 1, suspendedReason: "spend-cap" }],
            }),
        );

        await expect(resumeOrganization.handler(dunning.ctx, { organizationId: "org_1" } as never)).resolves.toStrictEqual({ resumed: ["acme"] });
        await expect(resumeOrganization.handler(off.ctx, { organizationId: "org_1" } as never)).resolves.toStrictEqual({ resumed: ["acme"] });
    });
});

describe("halts.setHaltOnSuspension", () => {
    it("lets an owner turn it off, audit-logged", async () => {
        const { ctx, ops } = makeCtx(tables());

        await setHaltOnSuspension.handler(ctx, { enabled: false, organizationId: "org_1" } as never);

        expect(ops).toContainEqual({ id: "org_1", kind: "patch", patch: { haltOnSuspension: false } });
        expect(inserted(ops, "auditLog").map((row) => [row["action"], row["target"]])).toStrictEqual([["halt.on_suspension", "off (overage, spend-cap)"]]);
    });

    it("refuses an admin: whether running code keeps billing past the cap is the owner's call", async () => {
        const { ctx } = makeCtx(tables({ members: [{ ...owner("org_1"), role: "admin" }] }));

        await expect(setHaltOnSuspension.handler(ctx, { enabled: false, organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe("halts.operatorHalt", () => {
    it("records support's stop as a manual halt by support", async () => {
        const { ctx, ops } = makeCtx(tables({ members: [] }), { userId: null });

        await operatorHalt.handler(ctx, { action: "halt", organizationId: "org_1" } as never);

        expect(inserted(ops, "halts").map((row) => [row["haltedBy"], row["reason"], row["source"]])).toStrictEqual([
            ["support", "support", "manual"],
            ["support", "support", "manual"],
        ]);
    });

    it("refuses support's resume while a covered suspension holds, like an owner's", async () => {
        const { ctx } = makeCtx(tables({ halts: [halt("acme", "p_acme")], organizations: [{ _id: "org_1", suspendedAt: 1, suspendedReason: "spend-cap" }] }), {
            userId: null,
        });

        await expect(operatorHalt.handler(ctx, { action: "resume", organizationId: "org_1" } as never)).rejects.toThrow(/until the suspension lifts/u);
    });
});

describe("halts.status", () => {
    it("shows the halts, what a stop would still reach, what it never reaches, and whether the suspension holds them", async () => {
        const { ctx } = makeCtx(
            tables({
                halts: [halt("acme", "p_acme", { lastError: "box busy", source: "suspension", state: "halting" })],
                organizations: [{ _id: "org_1", suspendedAt: 1, suspendedReason: "spend-cap" }],
            }),
        );
        const view = await status.handler(ctx, { organizationId: "org_1" } as never);

        expect(view).toMatchObject({ autoHalted: true, haltable: 1, haltOnSuspension: true, suspendedReason: "spend-cap" });
        expect(view.halts).toStrictEqual([
            {
                alias: "acme",
                attempts: 0,
                haltedBy: "usr_1",
                kind: "production",
                lastError: "box busy",
                projectId: "p_acme",
                reason: "manual",
                requestedAt: 5,
                source: "suspension",
                state: "halting",
            },
        ]);
        expect(view.unsupported.map((entry) => entry.alias)).toStrictEqual(["edge"]);
    });
});

describe("a halted project's release path", () => {
    const halted = (): ReturnType<typeof makeCtx> => makeCtx(tables({ halts: [halt("acme", "p_acme")] }));

    it("refuses a deploy", async () => {
        const { ctx, ops } = halted();

        await expect(create.handler(ctx, { kind: "production", organizationId: "org_1", projectId: "p_acme", scriptName: "acme" } as never)).rejects.toThrow(
            HALTED_REFUSAL,
        );
        expect(inserted(ops, "deployments")).toStrictEqual([]);
    });

    it("refuses a rollback, and the re-provision a rollback or a failed deploy's revert starts with", async () => {
        const { ctx } = halted();

        await expect(rollback.handler(ctx, { id: "d_acme", organizationId: "org_1" } as never)).rejects.toThrow(HALTED_REFUSAL);
        await expect(releaseTarget.handler(ctx, { id: "d_acme", organizationId: "org_1" } as never)).rejects.toThrow(HALTED_REFUSAL);
    });

    it("leaves another project's re-provision alone", async () => {
        const { ctx } = halted();

        await expect(releaseTarget.handler(ctx, { id: "d_shop", organizationId: "org_1" } as never)).resolves.toMatchObject({ alias: "shop" });
    });

    it("answers the deploy edge's last check by alias", async () => {
        const { ctx } = halted();

        await expect(aliasHalted.handler(ctx, { alias: "acme" })).resolves.toBe(true);
        await expect(aliasHalted.handler(ctx, { alias: "shop" })).resolves.toBe(false);
    });
});
