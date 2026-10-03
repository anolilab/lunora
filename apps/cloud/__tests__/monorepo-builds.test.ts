import { describe, expect, it } from "vitest";

import { DELIVERY_TTL_MS, recordPush, releaseTarget } from "../lunora/builds";
import { updateBuildSettings } from "../lunora/projects";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Monorepo push-to-deploy at the store: a push that touches nothing the
 * project watches is recorded as a `skipped` build with its reason (so the
 * Builds tab can say why nothing deployed), and the settings that drive it
 * are validated before they are stored.
 */

const ORG = "org_1";

const project = (over: Row = {}): Row => {
    return { _id: "prj_1", githubRepo: "acme/mono", name: "web", organizationId: ORG, slug: "web", ...over };
};

const world = (projectRow: Row, builds: Row[] = []): Record<string, Row[]> => {
    return {
        buildLogs: [],
        builds,
        githubInstallations: [{ _id: "inst_1", installationId: 42, organizationId: ORG }],
        members: [owner(ORG)],
        projects: [projectRow],
    };
};

const push = { branch: "main", commitSha: "abc123", installationId: 42, repository: "acme/mono", trigger: "push" as const };

describe("builds.recordPush path filter", () => {
    it("records a skipped build with the reason when no watched path changed", async () => {
        const { ctx, ops } = makeCtx(world(project({ rootDirectory: "apps/web" })));

        const result = await recordPush.handler(ctx, { ...push, changes: { files: ["apps/docs/index.md"] } });

        const reason = "no changes under apps/web/ or the lockfile (1 files changed)";

        expect(result).toStrictEqual({ buildId: "builds_new", reused: false, skipped: reason });
        expect(ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({
            document: { rootDirectory: "apps/web", skipReason: reason, status: "skipped" },
        });
    });

    it("queues a build, logging why, when a watched path changed", async () => {
        const { ctx, ops } = makeCtx(world(project({ rootDirectory: "apps/web" })));

        const result = await recordPush.handler(ctx, { ...push, changes: { files: ["apps/web/src/index.ts"] } });

        expect(result).toStrictEqual({ buildId: "builds_new", reused: false });
        expect(ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { rootDirectory: "apps/web", status: "pending" } });
        expect(ops.find((op) => op.kind === "insert" && op.table === "buildLogs")).toMatchObject({
            document: { line: "path filter: apps/web/src/index.ts changed" },
        });
    });

    it("builds when the payload cannot prove its changes", async () => {
        const { ctx } = makeCtx(world(project({ rootDirectory: "apps/web" })));

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({
            buildId: "builds_new",
            reused: false,
        });
    });

    it("builds when the changed-file list is longer than it will check", async () => {
        const { ctx } = makeCtx(world(project({ rootDirectory: "apps/web" })));
        const files = Array.from({ length: 1001 }, (_, index) => `apps/docs/${String(index)}.md`);

        await expect(recordPush.handler(ctx, { ...push, changes: { files } })).resolves.toStrictEqual({ buildId: "builds_new", reused: false });
    });

    it("does not reuse a bundle built from a different root directory", async () => {
        const previous = { _id: "bld_old", bundleHash: "h", commitSha: "abc123", projectId: "prj_1", rootDirectory: "apps/old", status: "successful" };
        const { ctx } = makeCtx(world(project({ rootDirectory: "apps/web" }), [previous]));

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({
            buildId: "builds_new",
            reused: false,
        });
    });

    it("reuses a bundle built from the same root directory while its release still serves", async () => {
        const previous = {
            _id: "bld_old",
            bundleHash: "h",
            commitSha: "abc123",
            createdAt: 1,
            deploymentId: "dep_old",
            projectId: "prj_1",
            rootDirectory: "apps/web",
            status: "successful",
            trigger: "push",
        };
        const { ctx, ops } = makeCtx({
            ...world(project({ rootDirectory: "apps/web" }), [previous]),
            deployments: [{ _id: "dep_old", projectId: "prj_1", status: "live" }],
        });

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({ buildId: "bld_old", reused: true });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "builds")).toStrictEqual([]);
    });

    /** Two builds of `abc123` (the newest re-released), then `def456` pushed on top of it. */
    const rebuiltCommit = (status: string) => {
        const builds = [
            {
                _id: "bld_first",
                branch: "main",
                bundleHash: "h",
                commitSha: "abc123",
                createdAt: 1,
                deploymentId: "dep_first",
                projectId: "prj_1",
                status: "successful",
                trigger: "push",
            },
            // The newest build of the commit is the one whose release is re-released.
            {
                _id: "bld_newest",
                branch: "main",
                bundleHash: "h",
                commitSha: "abc123",
                createdAt: 2,
                deploymentId: "dep_newest",
                projectId: "prj_1",
                status: "successful",
                trigger: "push",
            },
            {
                _id: "bld_head",
                branch: "main",
                bundleHash: "h2",
                commitSha: "def456",
                createdAt: 3,
                deploymentId: "dep_head",
                projectId: "prj_1",
                status: "successful",
                trigger: "push",
            },
        ];

        return makeCtx({
            ...world(project(), builds),
            deployments: [
                { _id: "dep_first", projectId: "prj_1", status: "superseded" },
                { _id: "dep_newest", projectId: "prj_1", status },
                { _id: "dep_head", projectId: "prj_1", status: "live" },
            ],
            githubDeliveries: [],
        });
    };

    it.each(["superseded", "failed", "destroyed"])("re-releases a commit already built whose release is %s, naming the build it reuses", async (status) => {
        const { ctx, ops } = rebuiltCommit(status);

        // The branch was reset from the newest commit pushed to it back to abc123.
        await expect(recordPush.handler(ctx, { ...push, before: "def456", changes: { unknown: "forced push" } })).resolves.toStrictEqual({
            buildId: "builds_new",
            reused: false,
        });
        expect(ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { reusesBuildId: "bld_newest", status: "pending" } });
    });

    it("never re-releases an older commit over a newer one for a stale or out-of-order push", async () => {
        const { ctx, ops } = rebuiltCommit("superseded");

        // abc123's own push, arriving after def456 was pushed on top of it: it moved the branch from abc123's parent.
        const result = await recordPush.handler(ctx, { ...push, before: "parent0", changes: { files: ["src/index.ts"] } });
        const inserted = ops.find((op) => op.kind === "insert" && op.table === "builds") as { document: Row } | undefined;

        expect(result).toMatchObject({
            buildId: "builds_new",
            reused: false,
            skipped: expect.stringContaining("the newest push recorded for it is def456") as unknown,
        });
        expect(inserted?.document).toMatchObject({ status: "skipped" });
        expect(inserted?.document).not.toHaveProperty("reusesBuildId");
    });

    it("records a webhook delivery once: a redelivery records nothing", async () => {
        const fresh = makeCtx({ ...world(project()), githubDeliveries: [] });

        await expect(recordPush.handler(fresh.ctx, { ...push, changes: { unknown: "forced push" }, deliveryId: "guid-1" })).resolves.toMatchObject({
            buildId: "builds_new",
        });
        expect(fresh.ops.find((op) => op.kind === "insert" && op.table === "githubDeliveries")).toMatchObject({ document: { deliveryId: "guid-1" } });

        const redelivered = makeCtx({ ...world(project()), githubDeliveries: [{ _id: "gd_1", deliveryId: "guid-1", receivedAt: 1 }] });

        await expect(recordPush.handler(redelivered.ctx, { ...push, changes: { unknown: "forced push" }, deliveryId: "guid-1" })).resolves.toStrictEqual({
            duplicate: true,
        });
        expect(redelivered.ops.filter((op) => op.kind === "insert" && op.table !== "rateLimits")).toStrictEqual([]);
    });

    it("forgets delivery ids past GitHub's redelivery window as it records new ones", async () => {
        const now = 10 * DELIVERY_TTL_MS;
        const { ctx, ops } = makeCtx(
            {
                ...world(project()),
                githubDeliveries: [
                    { _id: "gd_old", deliveryId: "guid-old", receivedAt: now - DELIVERY_TTL_MS - 1 },
                    { _id: "gd_recent", deliveryId: "guid-recent", receivedAt: now - 1 },
                ],
            },
            { now },
        );

        await recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" }, deliveryId: "guid-new" });

        expect(ops.filter((op) => op.kind === "delete")).toStrictEqual([{ id: "gd_old", kind: "delete" }]);
    });

    it("rebuilds a commit whose earlier build never recorded a deployment", async () => {
        const previous = { _id: "bld_old", bundleHash: "h", commitSha: "abc123", createdAt: 1, projectId: "prj_1", status: "successful", trigger: "push" };
        const { ctx, ops } = makeCtx(world(project(), [previous]));

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({
            buildId: "builds_new",
            reused: false,
        });

        const inserted = ops.find((op) => op.kind === "insert" && op.table === "builds") as { document: Row } | undefined;

        expect(inserted?.document).toMatchObject({ status: "pending" });
        expect(inserted?.document).not.toHaveProperty("reusesBuildId");
    });

    it("never re-releases a fork's build: it was never released", async () => {
        const previous = {
            _id: "bld_fork",
            bundleHash: "h",
            commitSha: "abc123",
            createdAt: 1,
            fromFork: true,
            projectId: "prj_1",
            status: "successful",
            trigger: "pull_request",
        };
        const { ctx } = makeCtx(world(project(), [previous]));

        await expect(
            recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" }, fromFork: true, pullRequest: 9, trigger: "pull_request" }),
        ).resolves.toStrictEqual({ buildId: "bld_fork", reused: true });
    });

    it("records what triggered the build — it decides production versus preview", async () => {
        const { ctx, ops } = makeCtx(world(project()));

        await recordPush.handler(ctx, { ...push, branch: "feat/x", changes: { unknown: "forced push" }, trigger: "pull_request" });

        expect(ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { branch: "feat/x", trigger: "pull_request" } });
    });

    it("records a fork's pull request as a fork, and hands the fork-ness to the release", async () => {
        const { ctx, ops } = makeCtx(world(project()));

        await recordPush.handler(ctx, {
            ...push,
            branch: "feat/x",
            changes: { unknown: "forced push" },
            fromFork: true,
            pullRequest: 9,
            trigger: "pull_request",
        });

        const inserted = ops.find((op) => op.kind === "insert" && op.table === "builds") as { document: Row } | undefined;

        expect(inserted).toMatchObject({ document: { fromFork: true, pullRequest: 9, trigger: "pull_request" } });

        const { ctx: readCtx } = makeCtx(world(project(), [{ ...inserted?.document, _id: "bld_fork" }]));

        await expect(releaseTarget.handler(readCtx, { buildId: "bld_fork" as never })).resolves.toMatchObject({ fromFork: true, pullRequest: 9 });
    });

    it("does not let a fork's unreleased build stand in for a same-repository pull request of the same commit", async () => {
        const previous = {
            _id: "bld_fork",
            bundleHash: "h",
            commitSha: "abc123",
            fromFork: true,
            projectId: "prj_1",
            status: "successful",
            trigger: "pull_request",
        };
        const { ctx } = makeCtx(world(project(), [previous]));

        await expect(
            recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" }, fromFork: false, pullRequest: 9, trigger: "pull_request" }),
        ).resolves.toStrictEqual({ buildId: "builds_new", reused: false });
    });

    it("does not let a pull request's preview build stand in for the production push of the same commit", async () => {
        // A fast-forward merge pushes the PR head's own SHA to the default branch.
        // Reusing the preview build there would mean the merge never released.
        const previous = { _id: "bld_pr", bundleHash: "h", commitSha: "abc123", projectId: "prj_1", status: "successful", trigger: "pull_request" };
        const { ctx } = makeCtx(world(project(), [previous]));

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({
            buildId: "builds_new",
            reused: false,
        });
    });
});

describe("projects.updateBuildSettings", () => {
    it("stores normalized settings and audits the change", async () => {
        const { ctx, ops } = makeCtx(world(project()));

        const result = await updateBuildSettings.handler(ctx, {
            id: "prj_1" as never,
            organizationId: ORG as never,
            rootDirectory: "apps/web/",
            watchPaths: ["apps/web/**", " ", "packages/ui/**"],
        });

        expect(result).toStrictEqual({ rootDirectory: "apps/web", watchPaths: ["apps/web/**", "packages/ui/**"] });
        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ patch: { rootDirectory: "apps/web", watchPaths: ["apps/web/**", "packages/ui/**"] } });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { action: "project.build_settings.update" } });
    });

    it("clears both settings with null rather than undefined", async () => {
        const { ctx, ops } = makeCtx(world(project({ rootDirectory: "apps/web", watchPaths: ["x/**"] })));

        await updateBuildSettings.handler(ctx, { id: "prj_1" as never, organizationId: ORG as never, rootDirectory: ".", watchPaths: [] });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ patch: { rootDirectory: null, watchPaths: null } });
    });

    it.each([["../etc"], ["/abs"], [String.raw`apps\web`]])("refuses the root directory %j as BAD_REQUEST", async (rootDirectory) => {
        const { ctx } = makeCtx(world(project()));

        await expect(
            updateBuildSettings.handler(ctx, { id: "prj_1" as never, organizationId: ORG as never, rootDirectory, watchPaths: [] }),
        ).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
    });
});
