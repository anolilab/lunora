import { describe, expect, it } from "vitest";

import { claimNext, recordPush, releaseTarget } from "../lunora/builds";
import { create as createDeployment } from "../lunora/deployments";
import { create, toProjectView, updateBuildSettings } from "../lunora/projects";
import { executeInContainer } from "../src/builds/container-exec";
import type { BuildPlace, BuildRunnerPorts } from "../src/builds/runner";
import { executeBuild } from "../src/builds/runner";
import { isProjectRuntime, runtimeColumn, storedRuntime } from "../src/project-runtime";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * A project's runtime (`src/project-runtime.ts`) travels exactly the way its
 * root directory does: from the project, snapshotted onto the build row when
 * the push is recorded, through the claim and the runner to the build box's
 * query parameter, and onto the release — and it is part of the build's dedup
 * key, so a bundle built one way is never re-released as the other.
 */

const ORG = "org_1";

const project = (over: Row = {}): Row => {
    return { _id: "prj_1", githubRepo: "acme/worker", name: "worker", organizationId: ORG, slug: "worker", ...over };
};

const world = (projectRow: Row, builds: Row[] = [], extra: Record<string, Row[]> = {}): Record<string, Row[]> => {
    return {
        buildLogs: [],
        builds,
        githubInstallations: [{ _id: "inst_1", installationId: 42, organizationId: ORG }],
        members: [owner(ORG)],
        projects: [projectRow],
        ...extra,
    };
};

const push = {
    branch: "main",
    changes: { unknown: "forced push" },
    commitSha: "abc123",
    installationId: 42,
    repository: "acme/worker",
    trigger: "push" as const,
};

const builtEarlier = (over: Row = {}): Row => {
    return {
        _id: "bld_old",
        bundleHash: "h",
        commitSha: "abc123",
        createdAt: 1,
        deploymentId: "dep_old",
        organizationId: ORG,
        projectId: "prj_1",
        status: "successful",
        trigger: "push",
        ...over,
    };
};

describe("the runtime column", () => {
    it("reads absence, SQL NULL and anything unknown as a Lunora app, and stores only worker", () => {
        expect.assertions(6);

        expect(storedRuntime(undefined)).toBe("lunora");
        expect(storedRuntime(null)).toBe("lunora");
        expect(storedRuntime("python")).toBe("lunora");
        expect(storedRuntime("worker")).toBe("worker");
        expect([runtimeColumn("lunora"), runtimeColumn(undefined), runtimeColumn("worker")]).toStrictEqual([{}, {}, { runtime: "worker" }]);
        expect([isProjectRuntime("worker"), isProjectRuntime("lunora"), isProjectRuntime("deno"), isProjectRuntime(1)]).toStrictEqual([
            true,
            true,
            false,
            false,
        ]);
    });

    it("shows every project with its runtime, a row from before the setting as a Lunora app", () => {
        expect.assertions(2);

        const row = { _id: "prj_1" as never, createdAt: 1, name: "w", organizationId: ORG as never, slug: "w" };

        expect(toProjectView(row).runtime).toBe("lunora");
        expect(toProjectView({ ...row, runtime: "worker" }).runtime).toBe("worker");
    });
});

describe("projects", () => {
    it("creates a project with the runtime it was given, storing nothing for a Lunora app", async () => {
        expect.assertions(2);

        const tables = (): Record<string, Row[]> => {
            return { aliasOwnership: [], deployments: [], members: [owner(ORG)], organizations: [{ _id: ORG }], projects: [], subscriptions: [] };
        };
        const worker = makeCtx(tables());
        const lunora = makeCtx(tables());

        await create.handler(worker.ctx, { name: "w", organizationId: ORG as never, runtime: "worker", slug: "w" });
        await create.handler(lunora.ctx, { name: "l", organizationId: ORG as never, slug: "l" });

        expect(worker.ops.find((op) => op.kind === "insert" && op.table === "projects")).toMatchObject({ document: { runtime: "worker" } });
        expect(lunora.ops.find((op) => op.kind === "insert" && op.table === "projects")).not.toHaveProperty("document.runtime");
    });

    it("switches the runtime in the build settings, audited, and keeps it when the form does not send one", async () => {
        expect.assertions(4);

        const switched = makeCtx(world(project()));
        const kept = makeCtx(world(project({ runtime: "worker" })));

        await expect(
            updateBuildSettings.handler(switched.ctx, {
                id: "prj_1" as never,
                organizationId: ORG as never,
                rootDirectory: "",
                runtime: "worker",
                watchPaths: [],
            }),
        ).resolves.toStrictEqual({ rootDirectory: "", runtime: "worker", watchPaths: [] });
        expect(switched.ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { target: "/ (worker)" } });
        await expect(
            updateBuildSettings.handler(kept.ctx, { id: "prj_1" as never, organizationId: ORG as never, rootDirectory: "", watchPaths: [] }),
        ).resolves.toMatchObject({ runtime: "worker" });
        expect(kept.ops.find((op) => op.kind === "patch")).toMatchObject({ patch: { runtime: "worker" } });
    });

    it("clears the runtime with null when switching back to a Lunora app", async () => {
        expect.assertions(1);

        const { ctx, ops } = makeCtx(world(project({ runtime: "worker" })));

        await updateBuildSettings.handler(ctx, { id: "prj_1" as never, organizationId: ORG as never, rootDirectory: "", runtime: "lunora", watchPaths: [] });

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ patch: { runtime: null } });
    });
});

describe("builds", () => {
    it("snapshots the project's runtime onto the build it records", async () => {
        expect.assertions(2);

        const worker = makeCtx(world(project({ runtime: "worker" })));
        const lunora = makeCtx(world(project()));

        await recordPush.handler(worker.ctx, push);
        await recordPush.handler(lunora.ctx, push);

        expect(worker.ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { runtime: "worker", status: "pending" } });
        expect(lunora.ops.find((op) => op.kind === "insert" && op.table === "builds")).not.toHaveProperty("document.runtime");
    });

    it("never reuses a bundle of the same commit built for the other runtime", async () => {
        expect.assertions(2);

        // Built as a Lunora app, still serving — and the project is now a plain Worker.
        const switched = makeCtx({
            ...world(project({ runtime: "worker" }), [builtEarlier()]),
            deployments: [{ _id: "dep_old", projectId: "prj_1", status: "live" }],
        });

        await expect(recordPush.handler(switched.ctx, push)).resolves.toStrictEqual({ buildId: "builds_new", reused: false });
        expect(switched.ops.find((op) => op.kind === "insert" && op.table === "builds")).toMatchObject({ document: { runtime: "worker" } });
    });

    it("reuses a bundle built for the same runtime while its release still serves", async () => {
        expect.assertions(1);

        const same = makeCtx({
            ...world(project({ runtime: "worker" }), [builtEarlier({ runtime: "worker" })]),
            deployments: [{ _id: "dep_old", projectId: "prj_1", status: "live" }],
        });

        await expect(recordPush.handler(same.ctx, push)).resolves.toStrictEqual({ buildId: "bld_old", reused: true });
    });

    it("hands the runtime to the runner with the claim, and to the release with its target", async () => {
        expect.assertions(2);

        const pending = {
            _id: "bld_1",
            branch: "main",
            commitSha: "abc123",
            createdAt: 1,
            organizationId: ORG,
            projectId: "prj_1",
            runtime: "worker",
            status: "pending",
            trigger: "push",
        };
        const claim = makeCtx(world(project({ runtime: "worker" }), [pending]));
        const target = makeCtx(world(project({ runtime: "lunora" }), [pending]));

        await expect(claimNext.handler(claim.ctx, { runnerId: "edge-1" })).resolves.toStrictEqual({
            buildId: "bld_1",
            commitSha: "abc123",
            projectId: "prj_1",
            runtime: "worker",
        });
        // The build's runtime, not the project's current one.
        await expect(releaseTarget.handler(target.ctx, { buildId: "bld_1" as never })).resolves.toMatchObject({ runtime: "worker" });
    });
});

describe("deployments", () => {
    const live = (runtime?: string): Row => {
        return {
            _id: "dep_live",
            alias: "web",
            createdAt: 1,
            kind: "production",
            organizationId: ORG,
            projectId: "prj_1",
            scriptName: "web",
            status: "live",
            ...(runtime === undefined ? {} : { runtime }),
        };
    };
    const release = async (deployments: Row[], runtime?: "worker") => {
        const { ctx, ops } = makeCtx({
            aliasOwnership: [],
            deployments,
            members: [owner(ORG)],
            projects: [{ _id: "prj_1", organizationId: ORG, slug: "web" }],
        });

        await createDeployment.handler(ctx, {
            kind: "production",
            organizationId: ORG as never,
            projectId: "prj_1" as never,
            ...(runtime === undefined ? {} : { runtime }),
            scriptName: "web",
        });

        return ops.find((op) => op.kind === "insert" && op.table === "deployments");
    };

    it("records the runtime a release is, and nothing for a Lunora app", async () => {
        expect.assertions(2);

        await expect(release([], "worker")).resolves.toMatchObject({ document: { runtime: "worker" } });
        await expect(release([])).resolves.not.toHaveProperty("document.runtime");
    });

    it("refuses to switch a live alias between runtimes, which would drop its Durable Object data", async () => {
        expect.assertions(2);

        await expect(release([live()], "worker")).rejects.toMatchObject({
            code: "CONFLICT",
            message:
                "web is running a Lunora app; releasing a Cloudflare Worker onto the same Worker would drop its Durable Object classes and their data. Deploy it as a new project, or switch this project's runtime back to Lunora app.",
        });
        await expect(release([live("worker")])).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("releases the same runtime again, and either runtime onto an alias with no live release", async () => {
        expect.assertions(3);

        await expect(release([live("worker")], "worker")).resolves.toMatchObject({ document: { runtime: "worker" } });
        await expect(release([live()])).resolves.toMatchObject({ document: { scriptName: "web" } });
        await expect(release([{ ...live(), status: "superseded" }], "worker")).resolves.toMatchObject({ document: { runtime: "worker" } });
    });
});

describe("runner and build box", () => {
    it("executes a claimed build with its root directory and runtime", async () => {
        expect.assertions(1);

        const places: BuildPlace[] = [];
        const ports: BuildRunnerPorts = {
            appendLog: () => Promise.resolve(),
            complete: () => Promise.resolve(),
            execute: (_source, place) => {
                places.push(place);

                return Promise.resolve({ bundle: "AA==", bundleHash: "h" });
            },
            fail: () => Promise.resolve(),
            fetchSource: () => Promise.resolve(new ArrayBuffer(1)),
        };

        await executeBuild({ buildId: "b1", commitSha: "abc", projectId: "p1", rootDirectory: "apps/edge", runtime: "worker" }, ports);

        expect(places).toStrictEqual([{ rootDirectory: "apps/edge", runtime: "worker" }]);
    });

    it.each([
        [undefined, "/__lunora/build"],
        [{}, "/__lunora/build"],
        // eslint-disable-next-line no-secrets/no-secrets -- an encoded query string, not a credential
        [{ rootDirectory: "apps/web" }, "/__lunora/build?rootDirectory=apps%2Fweb"],
        [{ runtime: "worker" as const }, "/__lunora/build?runtime=worker"],
        // eslint-disable-next-line no-secrets/no-secrets -- an encoded query string, not a credential
        [{ rootDirectory: "apps/edge", runtime: "worker" as const }, "/__lunora/build?rootDirectory=apps%2Fedge&runtime=worker"],
    ])("asks the build box for %j at %s", async (place, path) => {
        expect.assertions(1);

        const asked: string[] = [];
        const handle = {
            fetch: (requested: string) => {
                asked.push(requested);

                return Promise.resolve(new Response('{"bundle":"AA==","bundleHash":"h"}\n'));
            },
        };

        await executeInContainer(handle, new ArrayBuffer(1), place, () => Promise.resolve());

        expect(asked).toStrictEqual([path]);
    });
});
