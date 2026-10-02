import { describe, expect, expectTypeOf, it } from "vitest";

import type { Doc } from "../lunora/_generated/dataModel";
import { create } from "../lunora/deployments";
import { placement } from "../lunora/projects";
import type { TargetId } from "../src/provision-contract";
import { resolvePlacement } from "../src/targets/placement";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Placement from the database (plan 458 G3): a project's target is its own
 * column, a `cloudflare-wfp` project lives in its organization's cell, and a
 * control plane converges only what is placed on the cell it runs in.
 */

describe(resolvePlacement, () => {
    it("places a project that predates targets on cloudflare-wfp in this cell", () => {
        expect(resolvePlacement({ cellName: "default" }, "default")).toStrictEqual({ target: "cloudflare-wfp" });
        // A `.global()` row answers SQL NULL for an unset column.
        expect(resolvePlacement({ cellName: "default", target: null }, "default")).toStrictEqual({ target: "cloudflare-wfp" });
    });

    it("refuses a cloudflare-wfp project whose organization lives in another cell, naming both cells", () => {
        expect(() => resolvePlacement({ cellName: "eu-1", target: "cloudflare-wfp" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT", message: expect.stringMatching(/placed on cell "eu-1".*serves cell "default"/u) as string }),
        );
    });

    it("refuses a cloudflare-wfp project whose organization has no registered cell", () => {
        expect(() => resolvePlacement({ target: "cloudflare-wfp" }, "default")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    });

    it("places a celld-vps project on its box, whatever the cell", () => {
        expect(resolvePlacement({ box: { id: "box_1", revoked: false, slug: "bslug" }, cellName: "eu-1", target: "celld-vps" }, "default")).toStrictEqual({
            box: { id: "box_1", slug: "bslug" },
            target: "celld-vps",
        });
    });

    it("refuses a celld-vps project with no box, or a revoked one", () => {
        expect(() => resolvePlacement({ target: "celld-vps" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("names no box") as string }),
        );
        expect(() => resolvePlacement({ box: { id: "box_1", revoked: true, slug: "bslug" }, target: "celld-vps" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("revoked") as string }),
        );
    });

    it("refuses a target nothing answers to rather than falling back", () => {
        expect(() => resolvePlacement({ cellName: "default", target: "aws-lambda" }, "default")).toThrow(/unknown deploy target "aws-lambda"/u);
    });

    it("places a cloudflare-workers project in its connected account, converged by its organization's cell", () => {
        const account = { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" };

        expect(resolvePlacement({ account, cellName: "default", target: "cloudflare-workers" }, "default")).toStrictEqual({
            account,
            target: "cloudflare-workers",
        });
        // The account's state lives in the organization's cell, so another cell may not converge it.
        expect(() => resolvePlacement({ account, cellName: "eu-1", target: "cloudflare-workers" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(() => resolvePlacement({ cellName: "default", target: "cloudflare-workers" }, "default")).toThrow(/names no connected Cloudflare account/u);
    });

    it("keeps the schema's target union and TARGET_IDS in step", () => {
        expectTypeOf<NonNullable<Doc<"projects">["target"]>>().toEqualTypeOf<TargetId>();
        expectTypeOf<NonNullable<Doc<"deployments">["target"]>>().toEqualTypeOf<TargetId>();
        expectTypeOf<NonNullable<Doc<"cells">["target"]>>().toEqualTypeOf<TargetId>();
    });
});

describe("projects.placement", () => {
    const tables = (projectTarget?: string) => {
        return {
            cells: [{ _id: "cell_eu", name: "eu-1" }],
            organizations: [{ _id: "org_1", cellId: "cell_eu" }],
            projects: [{ _id: "proj_1", organizationId: "org_1", slug: "web", ...(projectTarget === undefined ? {} : { target: projectTarget }) }],
        };
    };

    it("reads the project's target and its organization's cell", async () => {
        const { ctx } = makeCtx(tables("celld-vps"));

        await expect(placement.handler(ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            target: "celld-vps",
        });
    });

    it("answers no target for a project that predates targets", async () => {
        const { ctx } = makeCtx(tables());

        await expect(placement.handler(ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({ cellName: "eu-1" });
    });

    it("reads the connected account of a cloudflare-workers project, never its token, and ignores another organization's", async () => {
        const account = { _id: "cfa_1", accountId: "a".repeat(32), ciphertext: "sealed", iv: "iv", organizationId: "org_1", workersSubdomain: "acme" };
        const project = { _id: "proj_1", cloudflareAccountId: "cfa_1", organizationId: "org_1", slug: "web", target: "cloudflare-workers" };
        const own = makeCtx({ ...tables(), cloudflareAccounts: [account], projects: [project] });

        await expect(placement.handler(own.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            account: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" },
            cellName: "eu-1",
            target: "cloudflare-workers",
        });

        const foreign = makeCtx({ ...tables(), cloudflareAccounts: [{ ...account, organizationId: "org_2" }], projects: [project] });

        await expect(placement.handler(foreign.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            target: "cloudflare-workers",
        });
    });

    it("refuses a project of another organization", async () => {
        const { ctx } = makeCtx(tables());

        await expect(placement.handler(ctx, { organizationId: "org_2", projectId: "proj_1" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("deployments.create", () => {
    const insertedDeployment = async (project: Record<string, unknown>) => {
        const { ctx, ops } = makeCtx({
            aliasOwnership: [],
            deployments: [],
            members: [owner("org_1")],
            projects: [{ _id: "proj_1", organizationId: "org_1", slug: "web", ...project }],
        });

        await create.handler(ctx, { kind: "production", organizationId: "org_1", projectId: "proj_1", scriptName: "web" } as never);

        return ops.find((op) => op.kind === "insert" && op.table === "deployments");
    };

    it("records the target it copies from the project, and the alias as the resource handle", async () => {
        await expect(insertedDeployment({ target: "celld-vps" })).resolves.toMatchObject({ document: { resourceRef: "web", target: "celld-vps" } });
    });

    it("records the box a celld-vps release runs on, so its teardown outlives the project", async () => {
        await expect(insertedDeployment({ boxId: "box_1", target: "celld-vps" })).resolves.toMatchObject({ document: { boxId: "box_1", target: "celld-vps" } });
    });

    it("records no box for a cloudflare-wfp release", async () => {
        const inserted = (await insertedDeployment({ boxId: "box_1", target: "cloudflare-wfp" })) as { document: Record<string, unknown> } | undefined;

        expect(inserted?.document).not.toHaveProperty("boxId");
    });

    it("records the account a cloudflare-workers release runs in, and qualifies its resource handle by it", async () => {
        await expect(insertedDeployment({ cloudflareAccountId: "cfa_1", target: "cloudflare-workers" })).resolves.toMatchObject({
            document: { cloudflareAccountId: "cfa_1", resourceRef: "cfa_1/web", scriptName: "web", target: "cloudflare-workers" },
        });
    });

    it("records cloudflare-wfp for a project that predates targets", async () => {
        await expect(insertedDeployment({})).resolves.toMatchObject({ document: { resourceRef: "web", scriptName: "web", target: "cloudflare-wfp" } });
    });
});
