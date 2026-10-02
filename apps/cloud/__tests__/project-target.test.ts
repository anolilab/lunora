import { describe, expect, it } from "vitest";

import { setTarget } from "../lunora/projects";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * `projects.setTarget` — the one writer of a project's placement: its target,
 * and the box or connected Cloudflare account that target needs.
 */

const NOW = 1_700_000_000_000;

const box = (overrides: Row = {}): Row => {
    return { _id: "box_1", createdAt: NOW, name: "edge", organizationId: "org_1", singleTrust: false, slug: "babcdefghij", status: "online", ...overrides };
};

const account = (overrides: Row = {}): Row => {
    return { _id: "cfa_1", accountId: "a".repeat(32), organizationId: "org_1", workersSubdomain: "acme", ...overrides };
};

describe("projects.setTarget", () => {
    const project = (overrides: Row = {}): Row => {
        return { _id: "proj_1", name: "web", organizationId: "org_1", slug: "web", ...overrides };
    };

    const call = (tables: Record<string, Row[]>, args: Record<string, unknown>) => {
        const fake = makeCtx({ members: [owner("org_1")], projects: [project()], ...tables }, { now: NOW });

        return {
            ops: fake.ops,
            run: () => setTarget.handler(fake.ctx, { organizationId: "org_1" as never, projectId: "proj_1" as never, ...args } as never),
        };
    };

    it("places a project on a box of its own org", async () => {
        const { ops, run } = call({ boxes: [box()], deployments: [] }, { boxId: "box_1", target: "celld-vps" });

        await run();

        expect(ops).toContainEqual({ id: "proj_1", kind: "patch", patch: { boxId: "box_1", cloudflareAccountId: null, target: "celld-vps" } });
    });

    it("requires a box for celld-vps and refuses one for cloudflare-wfp", async () => {
        await expect(call({ boxes: [box()] }, { target: "celld-vps" }).run()).rejects.toThrow("needs a box");
        await expect(call({ boxes: [box()] }, { boxId: "box_1", target: "cloudflare-wfp" }).run()).rejects.toThrow("has no box");
    });

    it("refuses another org's box and a revoked box", async () => {
        await expect(call({ boxes: [box({ organizationId: "org_2" })] }, { boxId: "box_1", target: "celld-vps" }).run()).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(call({ boxes: [box({ status: "revoked" })] }, { boxId: "box_1", target: "celld-vps" }).run()).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("refuses to move a project whose deployments are not torn down yet", async () => {
        const { ops, run } = call(
            { boxes: [box()], deployments: [{ _id: "dep_1", projectId: "proj_1", status: "destroyed", teardownAt: null }] },
            { boxId: "box_1", target: "celld-vps" },
        );

        await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });

    it("moves a project back to cloudflare-wfp and clears its box", async () => {
        const { ops, run } = call(
            {
                deployments: [{ _id: "dep_1", projectId: "proj_1", status: "destroyed", teardownAt: NOW }],
                projects: [project({ boxId: "box_1", target: "celld-vps" })],
            },
            { target: "cloudflare-wfp" },
        );

        await run();

        expect(ops).toContainEqual({ id: "proj_1", kind: "patch", patch: { boxId: null, cloudflareAccountId: null, target: "cloudflare-wfp" } });
    });

    it("places a project in a connected account of its own org", async () => {
        const { ops, run } = call({ cloudflareAccounts: [account()], deployments: [] }, { cloudflareAccountId: "cfa_1", target: "cloudflare-workers" });

        await run();

        expect(ops).toContainEqual({ id: "proj_1", kind: "patch", patch: { boxId: null, cloudflareAccountId: "cfa_1", target: "cloudflare-workers" } });
        expect(ops).toContainEqual(
            expect.objectContaining({
                document: expect.objectContaining({ action: "project.target.set", target: "cloudflare-workers:cfa_1" }),
                table: "auditLog",
            }),
        );
    });

    it("requires a connected account for cloudflare-workers, and refuses one anywhere else", async () => {
        await expect(call({ cloudflareAccounts: [account()] }, { target: "cloudflare-workers" }).run()).rejects.toThrow("needs a connected Cloudflare account");
        await expect(call({ cloudflareAccounts: [account()] }, { cloudflareAccountId: "cfa_1", target: "cloudflare-wfp" }).run()).rejects.toThrow(
            "has no Cloudflare account",
        );
        await expect(
            call({ boxes: [box()], cloudflareAccounts: [account()] }, { boxId: "box_1", cloudflareAccountId: "cfa_1", target: "celld-vps" }).run(),
        ).rejects.toThrow("has no Cloudflare account");
    });

    it("refuses another org's connected account", async () => {
        await expect(
            call({ cloudflareAccounts: [account({ organizationId: "org_2" })] }, { cloudflareAccountId: "cfa_1", target: "cloudflare-workers" }).run(),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});
