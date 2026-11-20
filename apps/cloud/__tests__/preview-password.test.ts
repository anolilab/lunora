import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { verifyPreviewPassword } from "../lunora/projects";
import { sha256Hex } from "../src/deploy/keys";

type Row = Record<string, unknown>;

const queryCtx = (world: { deployments: Row[]; ledger: Row[]; projects: Row[] }): QueryCtx => {
    const page = (all: Row[]) => Promise.resolve({ continueCursor: null, isDone: true, page: all });

    return {
        db: {
            aliasOwnership: { findMany: () => page(world.ledger) },
            deployments: { findMany: () => page(world.deployments) },
            get: (_table: string, id: string) => Promise.resolve(world.projects.find((row) => row["_id"] === id) ?? null),
        },
        now: Date.now(),
    } as unknown as QueryCtx;
};

const project = async (id: string, password: string): Promise<Row> => {
    return { _id: id, previewPasswordHash: await sha256Hex(`salt-${id}:${password}`), previewPasswordSalt: `salt-${id}` };
};

describe("projects.verifyPreviewPassword", () => {
    /**
     * A released alias keeps its former owner's release rows, and they come first
     * in the alias's history; the password checked must be the current owner's.
     */
    it("checks the alias's current owner, not the organization that held it before", async () => {
        const formerRelease = {
            _id: "d0",
            createdAt: 1,
            kind: "preview",
            organizationId: "org_old",
            projectId: "p_old",
            scriptName: "app-pr-7",
            status: "destroyed",
        };
        const currentRelease = {
            _id: "d1",
            createdAt: 2,
            kind: "preview",
            organizationId: "org_new",
            projectId: "p_new",
            scriptName: "app-pr-7",
            status: "live",
        };
        const context = queryCtx({
            deployments: [formerRelease, currentRelease],
            ledger: [{ alias: "app-pr-7", organizationId: "org_new", projectId: "p_new" }],
            projects: [await project("p_old", "old-password"), await project("p_new", "new-password")],
        });

        await expect(verifyPreviewPassword.handler(context, { password: "old-password", scriptName: "app-pr-7" })).resolves.toStrictEqual({ ok: false });
        await expect(verifyPreviewPassword.handler(context, { password: "new-password", scriptName: "app-pr-7" })).resolves.toStrictEqual({ ok: true });
    });
});
