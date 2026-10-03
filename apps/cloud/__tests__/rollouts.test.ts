import { describe, expect, it } from "vitest";

import { abortRollout, promoteRollout, setRollout } from "../lunora/rollouts";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Staged rollouts are refused on Workers for Platforms: a canary would be a
 * second script, and a Durable Object namespace belongs to the script defining
 * its class — so the canary would serve its share of traffic from an empty
 * database. The mutations remain to say so, after authorization.
 */

const ORG = "org_1";
const PROJECT = "prj_1";

describe("rollouts", () => {
    it("refuses to start a rollout, and writes nothing", async () => {
        const { ctx, ops } = makeCtx({ members: [owner(ORG)] });

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: expect.stringContaining("a canary cannot share the project's Durable Object data") as unknown as string,
        });
        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });

    it.each([
        ["promote", promoteRollout],
        ["abort", abortRollout],
    ])("refuses to %s — no rollout can exist", async (_label, mutation) => {
        const { ctx } = makeCtx({ members: [owner(ORG)] });

        await expect(mutation.handler(ctx, { organizationId: ORG as never, projectId: PROJECT as never })).rejects.toThrow(
            /not supported on Workers for Platforms/u,
        );
    });

    it("authorizes before explaining — a non-member learns nothing", async () => {
        const { ctx } = makeCtx({ members: [] });

        await expect(setRollout.handler(ctx, { id: "dep_candidate" as never, organizationId: ORG as never, percent: 10 })).rejects.not.toMatchObject({
            code: "BAD_REQUEST",
        });
    });
});
