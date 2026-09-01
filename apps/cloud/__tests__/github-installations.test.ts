import { describe, expect, it } from "vitest";

import { claim, list, unclaim } from "../lunora/github-installations";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * GitHub App installations, and the staged-claim model that keeps them honest.
 *
 * The webhook records an installation with NO organization, and an owner/admin
 * claims it from the dashboard — so a spoofed RPC call stages a harmless orphan
 * row at worst. What the pair has to guarantee is that a claim cannot be stolen
 * and a release cannot be forced by anyone but the holder, because an
 * installation is what push-to-deploy trusts to fetch a private repository.
 */

const ORG = "org_1";
const OTHER = "org_2";

const installation = (over: Row = {}): Row => {
    return { _id: "inst_1", accountLogin: "acme", createdAt: 1, installationId: 42, ...over };
};

const world = (rows: Row[]) => {
    return { githubInstallations: rows, members: [owner(ORG), owner(OTHER, "usr_other")] };
};

describe("github_installations.claim", () => {
    it("links a staged installation to the caller's organization", async () => {
        const { ctx, ops } = makeCtx(world([installation()]));

        await claim.handler(ctx, { installationId: 42, organizationId: ORG as never });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "inst_1", patch: { organizationId: ORG } });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { action: "github.installation.claim" } });
    });

    it("refuses an installation the App has never staged", async () => {
        const { ctx } = makeCtx(world([]));

        await expect(claim.handler(ctx, { installationId: 42, organizationId: ORG as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    /**
     * The theft case. Installation ids are small integers, so without this a
     * neighbouring tenant could guess one and attach another organization's GitHub
     * connection — and with it, push-to-deploy against their private repositories.
     */
    it("refuses an installation already claimed by another organization", async () => {
        const { ctx } = makeCtx(world([installation({ claimedAt: 1, organizationId: OTHER })]));

        await expect(claim.handler(ctx, { installationId: 42, organizationId: ORG as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("is idempotent for the organization that already holds it", async () => {
        const { ctx, ops } = makeCtx(world([installation({ claimedAt: 1, organizationId: ORG })]));

        await claim.handler(ctx, { installationId: 42, organizationId: ORG as never });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "inst_1" });
    });

    it("refuses a caller who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ githubInstallations: [installation()], members: [{ _id: "m", organizationId: ORG, role: "member", userId: "usr_1" }] });

        await expect(claim.handler(ctx, { installationId: 42, organizationId: ORG as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe("github_installations.unclaim", () => {
    it("releases the installation back to unclaimed rather than deleting it", async () => {
        const { ctx, ops } = makeCtx(world([installation({ claimedAt: 1, organizationId: ORG })]));

        await unclaim.handler(ctx, { installationId: 42, organizationId: ORG as never });

        // Released, not deleted — deleting would require reinstalling the App to
        // re-stage it, which is the same trap by a different route.
        expect(ops.filter((op) => op.kind === "delete")).toStrictEqual([]);
        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "inst_1", patch: { claimedAt: null, organizationId: null } });
    });

    it("records who released it", async () => {
        const { ctx, ops } = makeCtx(world([installation({ claimedAt: 1, organizationId: ORG })]));

        await unclaim.handler(ctx, { installationId: 42, organizationId: ORG as never });

        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { action: "github.installation.unclaim" } });
    });

    /**
     * The mirror of the theft case: without the ownership check this is a way to
     * DETACH another tenant's integration by guessing a numeric id, breaking their
     * push-to-deploy from outside their organization.
     */
    it("refuses to release an installation held by another organization", async () => {
        const { ctx } = makeCtx(world([installation({ claimedAt: 1, organizationId: OTHER })]));

        await expect(unclaim.handler(ctx, { installationId: 42, organizationId: ORG as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses to release one nobody holds", async () => {
        const { ctx } = makeCtx(world([installation()]));

        await expect(unclaim.handler(ctx, { installationId: 42, organizationId: ORG as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("github_installations.list", () => {
    it("returns only the caller organization's installations", async () => {
        const { ctx } = makeCtx(
            world([installation({ claimedAt: 1, organizationId: ORG }), installation({ _id: "inst_2", installationId: 99, organizationId: OTHER })]),
        );

        const rows = await list.handler(ctx, { organizationId: ORG as never });

        expect(rows.map((row) => row._id)).toStrictEqual(["inst_1"]);
    });
});
