import { describe, expect, it } from "vitest";

import { recordPush } from "../lunora/builds";
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

    it("reuses a bundle built from the same root directory", async () => {
        const previous = {
            _id: "bld_old",
            bundleHash: "h",
            commitSha: "abc123",
            projectId: "prj_1",
            rootDirectory: "apps/web",
            status: "successful",
            trigger: "push",
        };
        const { ctx } = makeCtx(world(project({ rootDirectory: "apps/web" }), [previous]));

        await expect(recordPush.handler(ctx, { ...push, changes: { unknown: "forced push" } })).resolves.toStrictEqual({ buildId: "bld_old", reused: true });
    });

    it("records what triggered the build — it decides production versus preview", async () => {
        const { ctx, ops } = makeCtx(world(project()));

        await recordPush.handler(ctx, { ...push, branch: "feat/x", changes: { unknown: "forced push" }, trigger: "pull_request" });

        expect(ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { branch: "feat/x", trigger: "pull_request" } });
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
