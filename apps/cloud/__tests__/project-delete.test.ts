import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { remove } from "../lunora/projects";

/**
 * Deleting a project.
 *
 * Projects could be created and renamed but never removed — the only way out was
 * deleting the entire organization, which is a far larger action than "I made
 * this by mistake" warrants.
 *
 * The behaviour worth pinning is the teardown contract it shares with org
 * erasure: project-scoped rows are deleted, but deployments are transitioned to
 * `destroyed` rather than deleted, because the sweep needs the row to find the
 * live dispatch script, tenant D1 and R2. Deleting it first orphans all three —
 * a resource leak with a monthly bill attached.
 */

type Row = Record<string, unknown>;

const PROJECT = "prj_1";
const ORG = "org_1";

const makeCtx = (tables: Record<string, Row[]>): { ctx: MutationCtx; deleted: string[]; patched: { id: string; patch: Row }[] } => {
    const deleted: string[] = [];
    const patched: { id: string; patch: Row }[] = [];
    const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);
    const facade = (table: string) => {
        return { findMany: (args?: { where?: Row }) => Promise.resolve({ page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) }) };
    };
    const emptyQuery: { first: () => Promise<null>; withIndex: () => typeof emptyQuery } = { first: () => Promise.resolve(null), withIndex: () => emptyQuery };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve({ subject: "usr_1" }), userId: "usr_1" },
        db: {
            aliasOwnership: facade("aliasOwnership"),
            buildLogs: facade("buildLogs"),
            builds: facade("builds"),
            delete: (id: string) => {
                deleted.push(id);

                return Promise.resolve();
            },
            deployments: facade("deployments"),
            domains: facade("domains"),
            get: (id: string) => Promise.resolve({ _id: id, organizationId: ORG }),
            insert: () => Promise.resolve("row_1"),
            members: facade("members"),
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
            query: () => emptyQuery,
            secrets: facade("secrets"),
        },
        log: { info: () => undefined },
        now: 1_700_000_000_000,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, deleted, patched };
};

const members = [{ _id: "mem_1", organizationId: ORG, role: "owner", userId: "usr_1" }];

describe("projects.remove", () => {
    it("deletes the project's own rows and the project itself", async () => {
        const { ctx, deleted } = makeCtx({
            deployments: [],
            members,
            secrets: [{ _id: "sec_1", projectId: PROJECT }],
        });

        await remove.handler(ctx, { id: PROJECT as never, organizationId: ORG as never });

        expect(deleted).toContain("sec_1");
        expect(deleted).toContain(PROJECT);
    });

    it("transitions deployments to destroyed rather than deleting them", async () => {
        const { ctx, deleted, patched } = makeCtx({
            deployments: [
                { _id: "dep_live", projectId: PROJECT, status: "live" },
                { _id: "dep_gone", projectId: PROJECT, status: "destroyed" },
            ],
            members,
        });

        const result = await remove.handler(ctx, { id: PROJECT as never, organizationId: ORG as never });

        // The teardown sweep needs the row to reach the real Cloudflare resources.
        expect(deleted).not.toContain("dep_live");
        expect(patched.find((entry) => entry.id === "dep_live")?.patch).toMatchObject({ status: "destroyed" });
        // An already-destroyed deployment is not re-stamped.
        expect(patched.find((entry) => entry.id === "dep_gone")).toBeUndefined();
        expect(result).toStrictEqual({ destroyed: 1 });
    });

    it("leaves org-scoped rows alone — this deletes a project, not an organization", async () => {
        const { ctx, deleted } = makeCtx({ deployments: [], members, secrets: [{ _id: "sec_other", projectId: "prj_other" }] });

        await remove.handler(ctx, { id: PROJECT as never, organizationId: ORG as never });

        expect(deleted).not.toContain("sec_other");
        expect(deleted).not.toContain("mem_1");
    });

    it("refuses a member who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ deployments: [], members: [{ _id: "mem_1", organizationId: ORG, role: "viewer", userId: "usr_1" }] });

        await expect(remove.handler(ctx, { id: PROJECT as never, organizationId: ORG as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
