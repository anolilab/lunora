import { describe, expect, it } from "vitest";

import { abortRollout, promoteRollout, setRollout } from "../lunora/rollouts";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Staged rollouts — the mutations that move live production traffic.
 *
 * Every guard here exists because the thing it forbids would send a share of
 * real users somewhere wrong, and none of them had a test. They are also the
 * least reversible operations in the control plane: a rollout points a fraction
 * of production at a second script, so an unchecked precondition is not a bad
 * error message, it is traffic on the floor.
 */

const ORG = "org_1";
const PROJECT = "prj_1";

const deployment = (over: Row = {}): Row => {
    return { _id: "dep_candidate", kind: "production", organizationId: ORG, projectId: PROJECT, scriptName: "app-v2", status: "live", ...over };
};

const project = (over: Row = {}): Row => {
    return { _id: PROJECT, activeDeploymentId: "dep_active", activeScriptName: "app-v1", organizationId: ORG, ...over };
};

const active = (over: Row = {}): Row => {
    return { _id: "dep_active", kind: "production", organizationId: ORG, projectId: PROJECT, scriptName: "app-v1", status: "live", ...over };
};

const world = (over: { deployments?: Row[]; projects?: Row[] } = {}) => {
    return {
        deployments: over.deployments ?? [deployment(), active()],
        members: [owner(ORG)],
        projects: over.projects ?? [project()],
    };
};

describe("rollouts.setRollout", () => {
    it("points the named share of traffic at the candidate", async () => {
        const { ctx, ops } = makeCtx(world());

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).resolves.toStrictEqual({
            percent: 10,
        });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({
            id: PROJECT,
            patch: { rollout: { deploymentId: "dep_candidate", percent: 10, scriptName: "app-v2" } },
        });
    });

    it("records who shifted the traffic", async () => {
        const { ctx, ops } = makeCtx(world());

        await setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 25 });

        // By table: the rate-limit middleware writes its own bucket row first, so
        // "the first insert" is not the audit entry.
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { action: "deployment.rollout.set" } });
    });

    it.each([
        [0, "zero"],
        [100, "a hundred"],
        [-5, "a negative share"],
    ])("refuses %s (%s)", async (percent) => {
        const { ctx } = makeCtx(world());

        // 100 is `promoteRollout`'s job — it also swaps the pointer and clears the
        // rollout. Letting `percent` reach it would leave a project serving entirely
        // from a candidate that is still not its active deployment: indistinguishable
        // from promoted, and undone by a single abort nobody expected to be destructive.
        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
    });

    it("refuses a candidate that is not live", async () => {
        const { ctx } = makeCtx(world({ deployments: [deployment({ status: "failed" }), active()] }));

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("refuses to roll a deployment out against itself", async () => {
        const { ctx } = makeCtx(world({ projects: [project({ activeDeploymentId: "dep_candidate" })] }));

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    /**
     * A preview carries a TTL and is destroyed by the cleanup sweep, so pointing
     * production traffic at one strands that share on a deployment already
     * scheduled for deletion — and `promoteRollout` supersedes only same-kind
     * siblings, so promoting it would leave the real production release live
     * alongside a preview holding the pointer.
     */
    it("refuses a candidate of a different kind to the active release", async () => {
        const { ctx } = makeCtx(world({ deployments: [deployment({ kind: "preview" }), active()] }));

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("refuses a caller who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ ...world(), members: [{ _id: "mem_1", organizationId: ORG, role: "viewer", userId: "usr_1" }] });

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });
});

const rollingOut = (over: Row = {}): Row => project({ rollout: { deploymentId: "dep_candidate", percent: 10, scriptName: "app-v2" }, ...over });

describe("rollouts.promoteRollout", () => {
    it("makes the candidate active, supersedes the old release, and clears the rollout", async () => {
        const { ctx, ops } = makeCtx(world({ projects: [rollingOut()] }));

        await promoteRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never });

        expect(ops.find((op) => op.kind === "patch" && op.id === "dep_active")).toMatchObject({ patch: { status: "superseded" } });
        expect(ops.find((op) => op.kind === "patch" && op.id === PROJECT)).toMatchObject({
            patch: { activeDeploymentId: "dep_candidate", activeScriptName: "app-v2", rollout: null },
        });
    });

    it("refuses when nothing is rolling out", async () => {
        const { ctx } = makeCtx(world());

        await expect(promoteRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    /**
     * Re-checked at promote time, not only when the rollout started: a rollout
     * stays open for as long as an operator leaves it, and in that window the
     * candidate can be superseded by another deploy or destroyed by a sweep.
     * Promoting then would point the project's stable URL at a dead script.
     */
    it("refuses a candidate that stopped being live while the rollout was open", async () => {
        const { ctx } = makeCtx(world({ deployments: [deployment({ status: "destroyed" }), active()], projects: [rollingOut()] }));

        await expect(promoteRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("refuses when the candidate row is gone entirely", async () => {
        const { ctx } = makeCtx(world({ deployments: [active()], projects: [rollingOut()] }));

        await expect(promoteRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("rollouts.abortRollout", () => {
    it("returns all traffic to the active release", async () => {
        const { ctx, ops } = makeCtx(world({ projects: [rollingOut()] }));

        await abortRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: PROJECT, patch: { rollout: null } });
    });

    /**
     * The candidate is left `live`, not superseded: it is a deployment that still
     * exists and may be rolled out again after a fix, and superseding it here
     * would make "we aborted the canary" indistinguishable from "we replaced it".
     */
    it("leaves the candidate deployment alone", async () => {
        const { ctx, ops } = makeCtx(world({ projects: [rollingOut()] }));

        await abortRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never });

        expect(ops.filter((op) => op.kind === "patch" && op.id === "dep_candidate")).toStrictEqual([]);
    });

    it("refuses when nothing is rolling out", async () => {
        const { ctx } = makeCtx(world());

        await expect(abortRollout.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });
});
