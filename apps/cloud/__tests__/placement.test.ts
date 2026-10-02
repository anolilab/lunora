import { describe, expect, expectTypeOf, it } from "vitest";

import type { Doc } from "../lunora/_generated/dataModel";
import { create } from "../lunora/deployments";
import { placement } from "../lunora/projects";
import type { TargetId } from "../src/provision-contract";
import type { RowReader } from "../src/targets/placement";
import { assertPlacementRef, PLACEMENT_HOSTS, placementOfDeployment, resolvePlacement, resourceRefOf } from "../src/targets/placement";
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
        expect(resolvePlacement({ cellName: "eu-1", host: { id: "box_1", slug: "bslug" }, hostRevoked: false, target: "celld-vps" }, "default")).toStrictEqual({
            host: { id: "box_1", slug: "bslug" },
            target: "celld-vps",
        });
    });

    it("refuses a celld-vps project with no box, or a revoked one", () => {
        expect(() => resolvePlacement({ target: "celld-vps" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("names no box") as string }),
        );
        expect(() => resolvePlacement({ host: { id: "box_1", slug: "bslug" }, hostRevoked: true, target: "celld-vps" }, "default")).toThrow(
            expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("revoked") as string }),
        );
    });

    it("refuses a target nothing answers to rather than falling back", () => {
        expect(() => resolvePlacement({ cellName: "default", target: "aws-lambda" }, "default")).toThrow(/unknown deploy target "aws-lambda"/u);
    });

    it("places a cloudflare-workers project in its connected account, converged by its organization's cell", () => {
        const account = { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" };

        expect(resolvePlacement({ cellName: "default", host: account, target: "cloudflare-workers" }, "default")).toStrictEqual({
            host: account,
            target: "cloudflare-workers",
        });
        // The account's state lives in the organization's cell, so another cell may not converge it.
        expect(() => resolvePlacement({ cellName: "eu-1", host: account, target: "cloudflare-workers" }, "default")).toThrow(
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

/** A {@link RowReader} over fixed rows per table, pinned like the real ones. */
const readerOver =
    (tables: Partial<Record<"boxes" | "cloudflareAccounts", Record<string, unknown>[]>>): RowReader =>
    async (table, id) =>
        tables[table]?.find((row) => row["_id"] === id) ?? null;

const BOX = { _id: "box_1", organizationId: "org_1", slug: "bslug000001", status: "online" };
const ACCOUNT = { _id: "cfa_1", accountId: "a".repeat(32), organizationId: "org_1", workersSubdomain: "acme" };

describe("pLACEMENT_HOSTS", () => {
    it("reads each kind of host from its own table only", async () => {
        const read = readerOver({ boxes: [BOX], cloudflareAccounts: [ACCOUNT] });

        await expect(PLACEMENT_HOSTS.box.lookup(read, "box_1")).resolves.toStrictEqual({
            host: { id: "box_1", slug: "bslug000001" },
            organizationId: "org_1",
            revoked: false,
        });
        await expect(PLACEMENT_HOSTS.account.lookup(read, "cfa_1")).resolves.toStrictEqual({
            host: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" },
            organizationId: "org_1",
            revoked: false,
        });
        // An account id is never a box, and the other way round.
        await expect(PLACEMENT_HOSTS.box.lookup(read, "cfa_1")).resolves.toBeNull();
        await expect(PLACEMENT_HOSTS.account.lookup(read, "box_1")).resolves.toBeNull();
    });
});

describe(assertPlacementRef, () => {
    const read = readerOver({ boxes: [BOX, { ...BOX, _id: "box_revoked", status: "revoked" }], cloudflareAccounts: [ACCOUNT] });

    it("accepts the organization's own host of the target's kind, and no host for a cell target", async () => {
        await expect(assertPlacementRef(read, "org_1", "celld-vps", "box_1")).resolves.toBeUndefined();
        await expect(assertPlacementRef(read, "org_1", "cloudflare-workers", "cfa_1")).resolves.toBeUndefined();
        await expect(assertPlacementRef(read, "org_1", "cloudflare-wfp", undefined)).resolves.toBeUndefined();
    });

    it("refuses a host of the wrong kind, another organization's, a revoked one, a missing one and a superfluous one", async () => {
        await expect(assertPlacementRef(read, "org_1", "celld-vps", "cfa_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(assertPlacementRef(read, "org_1", "cloudflare-workers", "box_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(assertPlacementRef(read, "org_2", "celld-vps", "box_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(assertPlacementRef(read, "org_1", "celld-vps", "box_revoked")).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(assertPlacementRef(read, "org_1", "celld-vps", undefined)).rejects.toThrow("needs a box");
        await expect(assertPlacementRef(read, "org_1", "cloudflare-workers", undefined)).rejects.toThrow("needs a connected Cloudflare account");
        await expect(assertPlacementRef(read, "org_1", "cloudflare-wfp", "box_1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

describe(placementOfDeployment, () => {
    const read = readerOver({ boxes: [BOX, { ...BOX, _id: "box_revoked", slug: "brevoked001", status: "revoked" }], cloudflareAccounts: [ACCOUNT] });

    it("places a deployment off the host its own row names", async () => {
        await expect(placementOfDeployment({ placementRef: "box_1", target: "celld-vps" }, read)).resolves.toStrictEqual({
            placement: { host: { id: "box_1", slug: "bslug000001" }, target: "celld-vps" },
        });
        await expect(placementOfDeployment({ placementRef: "cfa_1", target: "cloudflare-workers" }, read)).resolves.toStrictEqual({
            placement: { host: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" }, target: "cloudflare-workers" },
        });
        await expect(placementOfDeployment({ target: "cloudflare-wfp" }, read)).resolves.toStrictEqual({ placement: { target: "cloudflare-wfp" } });
    });

    it("settles a gone or revoked host, and keeps a row that names none pending", async () => {
        await expect(placementOfDeployment({ placementRef: "box_gone", target: "celld-vps" }, read)).resolves.toMatchObject({ settled: true });
        await expect(placementOfDeployment({ placementRef: "cfa_gone", target: "cloudflare-workers" }, read)).resolves.toMatchObject({ settled: true });
        await expect(placementOfDeployment({ placementRef: "box_revoked", target: "celld-vps" }, read)).resolves.toMatchObject({ settled: true });
        await expect(placementOfDeployment({ placementRef: null, target: "celld-vps" }, read)).resolves.toMatchObject({ settled: false });
    });
});

describe(resourceRefOf, () => {
    it("qualifies the alias by its host only where the host's readback reads more than one tenant", () => {
        expect(resourceRefOf({ placementRef: "cfa_1", target: "cloudflare-workers" }, "web")).toBe("cfa_1/web");
        expect(resourceRefOf({ placementRef: "box_1", target: "celld-vps" }, "web")).toBe("web");
        expect(resourceRefOf({ target: "cloudflare-wfp" }, "web")).toBe("web");
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
        const project = { _id: "proj_1", organizationId: "org_1", placementRef: "cfa_1", slug: "web", target: "cloudflare-workers" };
        const own = makeCtx({ ...tables(), cloudflareAccounts: [account], projects: [project] });

        await expect(placement.handler(own.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            host: { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" },
            hostRevoked: false,
            target: "cloudflare-workers",
        });

        const foreign = makeCtx({ ...tables(), cloudflareAccounts: [{ ...account, organizationId: "org_2" }], projects: [project] });

        await expect(placement.handler(foreign.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            target: "cloudflare-workers",
        });
    });

    it("reads a celld-vps project's box with whether it is revoked, and ignores a reference into another table", async () => {
        const project = { _id: "proj_1", organizationId: "org_1", placementRef: "box_1", slug: "web", target: "celld-vps" };
        const own = makeCtx({ ...tables(), boxes: [{ ...BOX, status: "revoked" }], projects: [project] });

        await expect(placement.handler(own.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            host: { id: "box_1", slug: "bslug000001" },
            hostRevoked: true,
            target: "celld-vps",
        });

        const crossed = makeCtx({ ...tables(), boxes: [], cloudflareAccounts: [{ ...ACCOUNT, _id: "box_1" }], projects: [project] });

        await expect(placement.handler(crossed.ctx, { organizationId: "org_1", projectId: "proj_1" } as never)).resolves.toStrictEqual({
            cellName: "eu-1",
            target: "celld-vps",
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

    it("records the box a celld-vps release runs on, so its teardown outlives the project, and leaves its handle unqualified", async () => {
        await expect(insertedDeployment({ placementRef: "box_1", target: "celld-vps" })).resolves.toMatchObject({
            document: { placementRef: "box_1", resourceRef: "web", target: "celld-vps" },
        });
    });

    it("records no host for a cloudflare-wfp release, even when its project kept a stale one", async () => {
        const inserted = (await insertedDeployment({ placementRef: "box_1", target: "cloudflare-wfp" })) as { document: Record<string, unknown> } | undefined;

        expect(inserted?.document).not.toHaveProperty("placementRef");
        expect(inserted?.document).toMatchObject({ resourceRef: "web" });
    });

    it("records the account a cloudflare-workers release runs in, and qualifies its resource handle by it", async () => {
        await expect(insertedDeployment({ placementRef: "cfa_1", target: "cloudflare-workers" })).resolves.toMatchObject({
            document: { placementRef: "cfa_1", resourceRef: "cfa_1/web", scriptName: "web", target: "cloudflare-workers" },
        });
    });

    it("records cloudflare-wfp for a project that predates targets", async () => {
        await expect(insertedDeployment({})).resolves.toMatchObject({ document: { resourceRef: "web", scriptName: "web", target: "cloudflare-wfp" } });
    });
});
