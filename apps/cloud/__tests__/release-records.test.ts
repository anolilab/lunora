import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { activate, pruneSuperseded, releaseTarget, rollback, SUPERSEDED_RETENTION } from "../lunora/deployments";

/**
 * The deployment records behind a project's one stable Worker. The Worker is
 * shared by every release of an alias, so these mutations are bookkeeping about
 * which stored release is on it — `activate` after a healthy deploy, `rollback`
 * after the edge re-provisioned a retained bundle — plus the retention window
 * `pruneSuperseded` enforces over the stored bundles.
 *
 * Driven through `.handler(ctx, args)` against a fake ctx.
 */

type Row = Record<string, unknown>;

const PROJECT = "prj_1";
const ORG = "org_1";

/**
 * A mutation ctx over in-memory deployment rows.
 *
 * `assertMember` reads `members` and the caller identity, so the double supplies
 * an owner; everything else the pointer paths touch is `deployments`, `projects`
 * and the audit insert.
 */
const makeCtx = (rows: Row[]): { ctx: MutationCtx; patched: { id: string; patch: Row }[] } => {
    const patched: { id: string; patch: Row }[] = [];
    const byId = new Map(rows.map((row) => [row["_id"] as string, row]));

    const tables: Record<string, Row[]> = { deployments: rows, members: [{ _id: "mem_1", organizationId: ORG, role: "owner", userId: "usr_1" }], projects: [] };
    const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);
    const findMany = (table: string) => (args?: { where?: Row }) =>
        Promise.resolve({ page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) });

    // `activate`/`rollback` carry `.use(rateLimit("machine"))`, and `.handler`
    // runs the middleware chain — so the double also has to satisfy the limiter's
    // store: a `query(table).withIndex(...).first()` that finds no existing bucket,
    // which is the "first request from this caller" path and always allows.
    const emptyQuery: { first: () => Promise<null>; withIndex: () => typeof emptyQuery } = {
        first: () => Promise.resolve(null),
        withIndex: () => emptyQuery,
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve({ subject: "usr_1" }), userId: "usr_1" },
        db: {
            deployments: { findMany: findMany("deployments") },
            query: () => emptyQuery,
            get: (id: string) => Promise.resolve(byId.get(id) ?? { _id: id, organizationId: ORG, slug: "web" }),
            insert: () => Promise.resolve("row_1"),
            members: { findMany: findMany("members") },
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
            projects: { findMany: findMany("projects") },
        },
        log: { info: () => undefined },
        now: 1_700_000_000_000,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, patched };
};

const deployment = (over: Row = {}): Row => {
    return {
        _id: "dep_new",
        alias: "app",
        createdAt: 2,
        kind: "production",
        organizationId: ORG,
        projectId: PROJECT,
        scriptName: "app",
        status: "live",
        ...over,
    };
};

/** The patch a pointer-moving mutation writes to the PROJECT row. */
const pointerPatch = (patched: { id: string; patch: Row }[]): Row | undefined => patched.find((entry) => entry.id === PROJECT)?.patch;

describe("deployments.activate", () => {
    it("moves the project pointer to a healthy production release", async () => {
        const { ctx, patched } = makeCtx([deployment(), deployment({ _id: "dep_old", createdAt: 1 })]);

        await activate.handler(ctx, { id: "dep_new" as never });

        expect(pointerPatch(patched)).toStrictEqual({ activeDeploymentId: "dep_new", activeScriptName: "app" });
    });

    it("supersedes the previously-live release of the same alias, and no other alias", async () => {
        const { ctx, patched } = makeCtx([
            deployment({ kind: "preview", alias: "app-pr-1", scriptName: "app-pr-1" }),
            deployment({ _id: "dep_old", alias: "app-pr-1", createdAt: 1, kind: "preview", scriptName: "app-pr-1" }),
            deployment({ _id: "dep_other_branch", alias: "app-pr-2", createdAt: 1, kind: "preview", scriptName: "app-pr-2" }),
        ]);

        await activate.handler(ctx, { id: "dep_new" as never });

        expect(patched.find((entry) => entry.id === "dep_old")?.patch).toMatchObject({ status: "superseded" });
        // Another branch's preview is its own Worker; superseding it would get it pruned and torn down.
        expect(patched.find((entry) => entry.id === "dep_other_branch")).toBeUndefined();
        // A preview never moves the project pointer — custom domains resolve through it.
        expect(pointerPatch(patched)).toBeUndefined();
    });
});

describe("deployments.rollback", () => {
    it("records the target live, supersedes the release it replaced, and moves the pointer", async () => {
        const { ctx, patched } = makeCtx([deployment({ _id: "dep_old", createdAt: 1, status: "superseded" }), deployment({ _id: "dep_live" })]);

        await expect(rollback.handler(ctx, { id: "dep_old" as never, organizationId: ORG as never })).resolves.toMatchObject({ scriptName: "app" });

        expect(patched.find((entry) => entry.id === "dep_old")?.patch).toMatchObject({ status: "live" });
        expect(patched.find((entry) => entry.id === "dep_live")?.patch).toMatchObject({ status: "superseded" });
        expect(pointerPatch(patched)).toStrictEqual({ activeDeploymentId: "dep_old", activeScriptName: "app" });
    });

    it("refuses a deployment that is not a retained release", async () => {
        const { ctx } = makeCtx([deployment({ _id: "dep_failed", status: "failed" })]);

        await expect(rollback.handler(ctx, { id: "dep_failed" as never, organizationId: ORG as never })).rejects.toMatchObject({ code: "CONFLICT" });
    });
});

describe("deployments.releaseTarget", () => {
    it("returns the sealed token, identity and the release currently on the Worker", async () => {
        const { ctx } = makeCtx([
            deployment({ _id: "dep_old", adminTokenCiphertext: "c", adminTokenIv: "i", createdAt: 1, status: "superseded" }),
            deployment({ _id: "dep_live" }),
        ]);

        await expect(releaseTarget.handler(ctx, { id: "dep_old" as never, organizationId: ORG as never })).resolves.toStrictEqual({
            adminTokenCiphertext: "c",
            adminTokenIv: "i",
            alias: "app",
            kind: "production",
            liveDeploymentId: "dep_live",
            projectId: PROJECT,
        });
    });

    it("refuses a failed deployment and one from another organization", async () => {
        const { ctx } = makeCtx([deployment({ _id: "dep_failed", status: "failed" }), deployment({ _id: "dep_foreign", organizationId: "org_2" })]);

        await expect(releaseTarget.handler(ctx, { id: "dep_failed" as never, organizationId: ORG as never })).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(releaseTarget.handler(ctx, { id: "dep_foreign" as never, organizationId: ORG as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("deployments.pruneSuperseded", () => {
    it("keeps the newest superseded releases per alias and never touches the live one", async () => {
        const superseded = Array.from({ length: SUPERSEDED_RETENTION + 2 }, (_, index) =>
            deployment({ _id: `dep_s${String(index)}`, createdAt: 10 + index, status: "superseded" }),
        );
        const { ctx, patched } = makeCtx([...superseded, deployment({ _id: "dep_live", createdAt: 100 })]);

        await expect(pruneSuperseded.handler(ctx, {})).resolves.toStrictEqual({ pruned: 2 });

        // The two oldest go; the teardown sweep then deletes their stored bundles.
        expect(patched.map((entry) => entry.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["dep_s0", "dep_s1"]);
        expect(patched.every((entry) => entry.patch["status"] === "destroyed")).toBe(true);
    });
});
