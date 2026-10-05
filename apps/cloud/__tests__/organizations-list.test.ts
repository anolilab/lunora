import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { getBySlug, list } from "../lunora/organizations";

/**
 * The org switcher and the slug lookup both used to read one page of EVERY
 * organization on the platform and match in memory.
 *
 * That is wasteful, but the reason it is a bug rather than a slow path is the
 * silent truncation: `findMany` returns a bounded page, so past that many
 * organizations a member's own org was simply absent from their switcher, and
 * their slug URL resolved to "not found". Nothing errored, nothing logged, and
 * the failure only appears once the platform has enough tenants — i.e. never in
 * development and all at once in production.
 */

type Row = Record<string, unknown>;

/**
 * A query ctx whose `organizations.findMany` refuses an unfiltered read.
 *
 * The point of the fix is that neither function asks for the whole table any
 * more, so the double enforces exactly that: a read with no `where` throws, and
 * a regression is a failing test rather than a slow one.
 */
const makeCtx = (userId: null | string, tables: Record<string, Row[]>): QueryCtx => {
    const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

    const findMany = (table: string) => (args?: { where?: Row }) => {
        if (table === "organizations" && !args?.where) {
            throw new Error("unfiltered read of every organization");
        }

        return Promise.resolve({ page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) });
    };

    return {
        auth: { getIdentity: () => Promise.resolve(userId ? { subject: userId } : null), userId },
        db: {
            get: (id: string) => Promise.resolve((tables["organizations"] ?? []).find((row) => row["_id"] === id) ?? null),
            members: { findMany: findMany("members") },
            organizations: { findMany: findMany("organizations") },
        },
    } as unknown as QueryCtx;
};

const orgs: Row[] = [
    { _id: "org_1", createdAt: 1, name: "Acme", plan: "pro", slug: "acme" },
    { _id: "org_2", createdAt: 2, name: "Globex", plan: "free", slug: "globex" },
    { _id: "org_3", createdAt: 3, name: "Initech", plan: "free", slug: "initech" },
];

describe("organizations.list", () => {
    it("returns exactly the caller's organizations, fetched by id", async () => {
        const ctx = makeCtx("usr_1", {
            members: [
                { organizationId: "org_1", userId: "usr_1" },
                { organizationId: "org_3", userId: "usr_1" },
                { organizationId: "org_2", userId: "usr_other" },
            ],
            organizations: orgs,
        });

        const result = await list.handler(ctx, {});

        expect(result.map((organization) => organization._id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["org_1", "org_3"]);
    });

    it("returns nothing for a member of nothing, without reading the table", async () => {
        const ctx = makeCtx("usr_lonely", { members: [], organizations: orgs });

        await expect(list.handler(ctx, {})).resolves.toStrictEqual([]);
    });

    it("skips a membership whose organization no longer exists rather than yielding a null row", async () => {
        const ctx = makeCtx("usr_1", { members: [{ organizationId: "org_gone", userId: "usr_1" }], organizations: orgs });

        await expect(list.handler(ctx, {})).resolves.toStrictEqual([]);
    });

    it("refuses an unauthenticated caller", async () => {
        const ctx = makeCtx(null, { members: [], organizations: orgs });

        await expect(list.handler(ctx, {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
});

describe("organizations.getBySlug", () => {
    it("resolves through the slug index rather than scanning", async () => {
        const ctx = makeCtx("usr_1", { members: [{ organizationId: "org_2", userId: "usr_1" }], organizations: orgs });

        await expect(getBySlug.handler(ctx, { slug: "globex" })).resolves.toMatchObject({ _id: "org_2" });
    });

    it("answers null for an unknown slug", async () => {
        const ctx = makeCtx("usr_1", { members: [], organizations: orgs });

        await expect(getBySlug.handler(ctx, { slug: "nope" })).resolves.toBeNull();
    });
});
