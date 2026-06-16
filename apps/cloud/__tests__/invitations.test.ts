import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { accept } from "../lunora/invitations";
import { sha256Hex } from "../src/deploy/keys";

type Row = Record<string, unknown>;

const makeCtx = (
    userId: null | string,
    tables: Record<string, Row[]>,
): { ctx: MutationCtx; inserted: { doc: Row; table: string }[]; patched: { id: string; patch: Row }[] } => {
    const inserted: { doc: Row; table: string }[] = [];
    const patched: { id: string; patch: Row }[] = [];
    const database: Record<string, unknown> = {
        insert: (table: string, doc: Row) => {
            inserted.push({ doc, table });

            return Promise.resolve(`${table}_new`);
        },
        patch: (id: string, patch: Row) => {
            patched.push({ id, patch });

            return Promise.resolve();
        },
    };

    for (const [name, rows] of Object.entries(tables)) {
        database[name] = {
            findMany: (args?: { where?: Row }) => {
                const where = args?.where ?? {};

                return Promise.resolve({ page: rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)) });
            },
        };
    }

    return {
        ctx: {
            auth: { getIdentity: () => Promise.resolve(null), userId },
            db: database,
            log: {},
            runMutation: () => Promise.resolve(undefined),
            runQuery: () => Promise.resolve(undefined),
            scheduler: {},
            storage: {},
            vectors: {},
        } as unknown as MutationCtx,
        inserted,
        patched,
    };
};

describe("invitations.accept", () => {
    it("adds the caller as a member and marks the invitation accepted", async () => {
        const token = "invite-token";
        const tokenHash = await sha256Hex(token);
        const { ctx, inserted, patched } = makeCtx("u_new", {
            invitations: [{ _id: "inv1", expiresAt: Date.now() + 100_000, organizationId: "org_1", role: "member", status: "pending", tokenHash }],
            members: [],
        });

        const result = await accept.handler(ctx, { token });

        expect(result).toStrictEqual({ organizationId: "org_1" });
        expect(inserted).toStrictEqual([{ doc: expect.objectContaining({ organizationId: "org_1", role: "member", userId: "u_new" }), table: "members" }]);
        expect(patched).toStrictEqual([{ id: "inv1", patch: { status: "accepted" } }]);
    });

    it("rejects an expired or revoked invitation", async () => {
        const token = "t";
        const tokenHash = await sha256Hex(token);
        const { ctx } = makeCtx("u_new", {
            invitations: [{ _id: "inv1", expiresAt: Date.now() - 1, organizationId: "org_1", role: "member", status: "pending", tokenHash }],
            members: [],
        });

        await expect(accept.handler(ctx, { token })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("requires a signed-in caller", async () => {
        const { ctx } = makeCtx(null, { invitations: [], members: [] });

        await expect(accept.handler(ctx, { token: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
});
