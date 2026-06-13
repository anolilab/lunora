import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../cirrus/_generated/server";
import { assertMember, authorizeDeployKey } from "../cirrus/authz";
import { hashDeployKey } from "../src/deploy/keys";

type Row = Record<string, unknown>;

/** Minimal fake ctx: a per-table `findMany({ where })` over in-memory rows. */
const makeCtx = (userId: null | string, tables: Record<string, Row[]>): QueryCtx => {
    const database: Record<string, unknown> = {};

    for (const [name, rows] of Object.entries(tables)) {
        database[name] = {
            findMany: (args?: { where?: Row }) => {
                const where = args?.where ?? {};
                const page = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

                return Promise.resolve({ page });
            },
        };
    }

    return {
        auth: { getIdentity: () => Promise.resolve(null), userId },
        db: database,
        log: {},
        runQuery: () => Promise.resolve(undefined),
        storage: {},
        vectors: {},
    } as unknown as QueryCtx;
};

const org = "org_1" as Parameters<typeof assertMember>[1];

describe(assertMember, () => {
    it("throws UNAUTHORIZED when not signed in", async () => {
        await expect(assertMember(makeCtx(null, { members: [] }), org)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("throws FORBIDDEN when the caller is not a member", async () => {
        await expect(assertMember(makeCtx("u1", { members: [] }), org)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("resolves the member and enforces allowedRoles", async () => {
        const context = makeCtx("u1", { members: [{ _id: "m1", organizationId: "org_1", role: "admin", userId: "u1" }] });

        await expect(assertMember(context, org, ["admin"])).resolves.toStrictEqual({ role: "admin", userId: "u1" });
        await expect(assertMember(context, org, ["owner"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe(authorizeDeployKey, () => {
    it("returns the key id for a valid, org-matching key", async () => {
        const key = "production:org_1|secret";
        const hashedKey = await hashDeployKey(key);
        const context = makeCtx(null, { deployKeys: [{ _id: "dk1", hashedKey, organizationId: "org_1" }] });

        await expect(authorizeDeployKey(context, org, key)).resolves.toBe("dk1");
    });

    it("rejects a revoked key", async () => {
        const key = "production:org_1|secret";
        const hashedKey = await hashDeployKey(key);
        const context = makeCtx(null, { deployKeys: [{ _id: "dk1", hashedKey, organizationId: "org_1", revokedAt: 1 }] });

        await expect(authorizeDeployKey(context, org, key)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a key scoped to a different org", async () => {
        const key = "production:org_2|secret";
        const hashedKey = await hashDeployKey(key);
        const context = makeCtx(null, { deployKeys: [{ _id: "dk1", hashedKey, organizationId: "org_2" }] });

        await expect(authorizeDeployKey(context, org, key)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
