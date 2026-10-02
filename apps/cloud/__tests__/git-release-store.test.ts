import { describe, expect, it } from "vitest";

import { releaseTarget } from "../lunora/builds";
import { recordReleaseKey, removeReleaseKey } from "../lunora/deploy-keys";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * The rows a git build's release reads and writes: where the build releases to
 * (from the build and project rows, never the caller), and the one-release
 * deploy key, which can only ever be scoped to the build's own project.
 */

const ORG = "org_1";

const world = (over: { build?: Row; deployKeys?: Row[]; project?: Row } = {}): Record<string, Row[]> => {
    return {
        builds: [
            { _id: "bld_1", branch: "main", commitSha: "abc", organizationId: ORG, projectId: "prj_1", status: "building", trigger: "push", ...over.build },
        ],
        deployKeys: over.deployKeys ?? [],
        projects: [{ _id: "prj_1", activeScriptName: "acme-web", name: "web", organizationId: ORG, slug: "web", ...over.project }],
    };
};

describe("builds.releaseTarget", () => {
    it("reads the project, its alias and the build's trigger off the rows", async () => {
        const { ctx } = makeCtx(world());

        await expect(releaseTarget.handler(ctx, { buildId: "bld_1" as never })).resolves.toStrictEqual({
            activeScriptName: "acme-web",
            branch: "main",
            organizationId: ORG,
            projectId: "prj_1",
            projectSlug: "web",
            trigger: "push",
        });
    });

    it("leaves the trigger out of a row recorded before it existed", async () => {
        const { ctx } = makeCtx(world({ build: { trigger: undefined } }));
        const target = await releaseTarget.handler(ctx, { buildId: "bld_1" as never });

        expect(target).not.toHaveProperty("trigger");
    });

    it("answers null for a build whose project left its organization", async () => {
        const { ctx } = makeCtx(world({ project: { organizationId: "org_other" } }));

        await expect(releaseTarget.handler(ctx, { buildId: "bld_1" as never })).resolves.toBeNull();
    });
});

describe("deploy_keys release keys", () => {
    const args = { buildId: "bld_1" as never, hashedKey: "hash", organizationId: ORG as never, projectId: "prj_1" as never, type: "production" as const };

    it("records a key scoped to the build's own project, named for the build", async () => {
        const { ctx, ops } = makeCtx(world());

        await recordReleaseKey.handler(ctx, args);

        expect(ops.find((op) => op.kind === "insert" && op.table === "deployKeys")).toMatchObject({
            document: { hashedKey: "hash", name: "Git build release (bld_1)", organizationId: ORG, projectId: "prj_1", type: "production" },
        });
    });

    it("refuses a key aimed at any other project", async () => {
        const { ctx, ops } = makeCtx(world());

        await expect(recordReleaseKey.handler(ctx, { ...args, projectId: "prj_other" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(ops).toStrictEqual([]);
    });

    it("deletes only the key minted for that build", async () => {
        const releaseKey = { _id: "key_1", name: "Git build release (bld_1)", organizationId: ORG };
        const userKey = { _id: "key_2", name: "CI", organizationId: ORG };
        const { ctx, ops } = makeCtx(world({ deployKeys: [releaseKey, userKey] }));

        await removeReleaseKey.handler(ctx, { buildId: "bld_1" as never, id: "key_1" as never });

        await expect(removeReleaseKey.handler(ctx, { buildId: "bld_1" as never, id: "key_2" as never })).rejects.toMatchObject({ code: "NOT_FOUND" });

        expect(ops).toStrictEqual([{ id: "key_1", kind: "delete" }]);
    });
});
