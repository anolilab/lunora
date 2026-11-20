import { describe, expect, it } from "vitest";

import { installedProjects } from "../lunora/builds";
import { activate, create } from "../lunora/deployments";
import { remove } from "../lunora/projects";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * A project's release history is never deleted — pruned releases stay as
 * `destroyed` rows — so a busy project outgrows the one 1000-row page a
 * `findMany` answers with. These drive the deployment bookkeeping over a store
 * that pages the way the real one does, with the row that matters past the first
 * page.
 */

const PAGE = 1000;
const ORG = "org_1";
const PROJECT = "proj_1";

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([field, value]) => row[field] === value);

/** `findMany` as the store answers it: at most one page, resumed from `cursor`, in insertion order. */
const pagedFindMany =
    (rows: Row[]) =>
    (args?: { cursor?: null | string; where?: Row }): Promise<{ continueCursor: null | string; isDone: boolean; page: Row[] }> => {
        const matching = rows.filter((row) => matches(row, args?.where ?? {}));
        const start = Number(args?.cursor ?? 0);
        const end = start + PAGE;
        const isDone = end >= matching.length;

        return Promise.resolve({ continueCursor: isDone ? null : String(end), isDone, page: matching.slice(start, end) });
    };

/** A page of history that holds nothing still running: releases pruned long ago. */
const destroyedHistory = (): Row[] =>
    Array.from({ length: PAGE }, (_, index) => {
        return {
            _id: `dep_${String(index)}`,
            alias: "web",
            createdAt: index + 1,
            kind: "production",
            organizationId: ORG,
            projectId: PROJECT,
            scriptName: "web",
            status: "destroyed",
            version: index + 1,
        };
    });

const liveRow = (over: Row = {}): Row => {
    return {
        _id: "dep_live",
        alias: "web",
        createdAt: 5000,
        durableObjectClasses: ["ShardDO", "Chat"],
        kind: "production",
        organizationId: ORG,
        projectId: PROJECT,
        scriptName: "web",
        status: "live",
        version: PAGE + 1,
        ...over,
    };
};

const storeWith = (deployments: Row[]) => {
    const store = makeCtx({
        aliasOwnership: [{ _id: "own_web", alias: "web", organizationId: ORG, projectId: PROJECT }],
        buildLogs: [],
        builds: [],
        deployments,
        domains: [],
        halts: [],
        members: [owner(ORG)],
        organizations: [{ _id: ORG }],
        projects: [{ _id: PROJECT, organizationId: ORG, slug: "web" }],
        secrets: [],
    });

    // The shared double answers every match in one page; this table pages like the store.
    (store.ctx.db as unknown as { deployments: Record<string, unknown> }).deployments["findMany"] = pagedFindMany(deployments);

    return store;
};

describe("deployment bookkeeping past the first page", () => {
    it("finds the live release, numbers past it, and keeps its Durable Object data", async () => {
        expect.assertions(2);

        const { ctx } = storeWith([...destroyedHistory(), liveRow()]);
        const release = { kind: "production", organizationId: ORG, projectId: PROJECT, scriptName: "web" } as never;

        // Dropping `Chat` deletes its data: refused, though the release binding it is past page one.
        await expect(create.handler(ctx, { ...(release as object), statefulClasses: ["ShardDO"] } as never)).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(create.handler(ctx, { ...(release as object), statefulClasses: ["ShardDO", "Chat"] } as never)).resolves.toStrictEqual({
            deploymentId: "deployments_new",
            previousDeploymentId: "dep_live",
            version: PAGE + 2,
        });
    });

    it("refuses to activate an older release when the newer live one is past the first page", async () => {
        expect.assertions(1);

        const { ctx } = storeWith([liveRow({ _id: "dep_older", createdAt: 1, status: "verifying" }), ...destroyedHistory(), liveRow()]);

        await expect(activate.handler(ctx, { id: "dep_older" as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("hands every standing release of a deleted project to the teardown sweep", async () => {
        expect.assertions(2);

        const { ctx, ops } = storeWith([...destroyedHistory(), liveRow()]);

        await remove.handler(ctx, { id: PROJECT as never, organizationId: ORG as never });

        expect(ops).toContainEqual({ id: "dep_live", kind: "patch", patch: expect.objectContaining({ status: "destroyed" }) });
        // The live release is not torn down yet, so its alias stays claimed until the sweep has.
        expect(ops).not.toContainEqual({ id: "own_web", kind: "delete" });
    });
});

describe("pull request bookkeeping past the first page", () => {
    it("finds a connected project and its installation claim past the first page of each", async () => {
        expect.assertions(1);

        const { ctx } = storeWith([]);
        const database = ctx.db as unknown as Record<string, Record<string, unknown>>;
        // Squatted siblings in other organizations fill the repository's first page of projects …
        const squatters = Array.from({ length: PAGE }, (_, index) => {
            return { _id: `proj_squat_${String(index)}`, githubRepo: "acme/app", organizationId: `org_squat_${String(index)}` };
        });
        // … and of the installation's claims.
        const claims = Array.from({ length: PAGE }, (_, index) => {
            return { _id: `claim_${String(index)}`, installationId: 7, organizationId: `org_other_${String(index)}` };
        });

        database["projects"] = { findMany: pagedFindMany([...squatters, { _id: PROJECT, githubRepo: "acme/app", organizationId: ORG }]) };
        database["githubInstallations"] = { findMany: pagedFindMany([...claims, { _id: "claim_org_1", installationId: 7, organizationId: ORG }]) };

        const projects = await installedProjects(ctx, "Acme/App", 7);

        expect(projects.map((project) => project._id)).toStrictEqual([PROJECT]);
    });
});
