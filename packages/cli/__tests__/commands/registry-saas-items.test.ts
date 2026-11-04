/**
 * The shipped SaaS kit functions, EXECUTED over an in-memory `ctx.db`.
 *
 * `registry/` is copy-in source whose only gate is a type-check, which cannot say
 * whether an archived project frees its name, whether a deleted organisation
 * frees its slug, or whether a second checkout is refused. The unique indexes the
 * kit declares are enforced here by the fake database, because those constraints
 * are what the cases below are about: a fake that accepted a duplicate slug would
 * pass the broken code.
 *
 * `packages/cli/vitest.config.ts` aliases the specifiers the items import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Handler, Row } from "../helpers/registry-runtime";
import { createDatabase, load, signedIn } from "../helpers/registry-runtime";

// The items import their table names from a sibling `schema.ts`, which pulls in `@lunora/server`.
// That package is not a dependency here and aliasing it would reach every suite, so the two
// constants-only modules the handlers read are replaced by their values.
// eslint-disable-next-line vitest/prefer-import-in-mock -- an `import()` type would pull the item into this package's `tsc` program, where `@lunora/server` does not resolve
vi.mock("../../../../registry/saas/schema.ts", () => {
    return {
        SAAS_ACTIVITY_PAGE: 50,
        SAAS_ACTIVITY_TABLE: "saas_activity",
        SAAS_ORGANIZATIONS_TABLE: "saas_organizations",
        SAAS_PROJECTS_TABLE: "saas_projects",
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- an `import()` type would pull the item into this package's `tsc` program, where `@lunora/server` does not resolve
vi.mock("../../../../registry/presence/schema.ts", () => {
    return { PRESENCE_TABLE: "presence_present", PRESENCE_TTL_MS: 30_000 };
});

interface OrganizationFilter {
    plan?: string;
    search?: string;
}

interface OrganizationListArgs extends OrganizationFilter {
    paginationOpts: { cursor?: string | null; endCursor?: string | null; numItems: number };
}

describe("saas kit functions", () => {
    const NOW = 1_700_000_000_000;

    interface Saas {
        archiveProject: Handler<Record<"projectId", string>, void>;
        createProject: Handler<{ name: string }, string>;
        listOrganizations: Handler<OrganizationListArgs, { continueCursor: string | null; isDone: boolean; page: Row[]; splitCursor?: string | null }>;
        organizationTotals: Handler<OrganizationFilter, { organizations: number; seats: number }>;
        syncOrganization: Handler<{ name: string; organizationId: string; plan?: string; seats?: number; slug: string; status?: string }, void>;
        syncOrganizationPlan: Handler<{ asOf: number; organizationId: string; plan: string }, void>;
    }

    const SAAS_UNIQUE = {
        saas_organizations: [["organizationId"], ["slug"]],
        saas_projects: [["organizationId", "slug"]],
    };

    const setup = async () => {
        const saas = await load<Saas>("registry", "saas", "saas.ts");
        const { db, rows } = createDatabase(SAAS_UNIQUE);
        const writer = {
            auth: { ...signedIn({ activeOrganizationId: "org-1", orgRole: "owner" }), userId: "user-1" },
            db,
            log: { info: vi.fn<(message: string) => void>() },
            now: NOW,
            shardKey: "org-1",
        };

        return { db, rows, saas, writer };
    };

    describe("createProject", () => {
        it("slugs a name written in a non-Latin script instead of rejecting it", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();

            await saas.createProject({ args: { name: "Мой проект" }, ctx: writer });
            await saas.createProject({ args: { name: "か" }, ctx: writer });
            await saas.createProject({ args: { name: "が" }, ctx: writer });

            expect(rows("saas_projects").map((row) => row["slug"])).toStrictEqual(["мой-проект", "か", "が"]);

            await expect(saas.createProject({ args: { name: "МОЙ ПРОЕКТ" }, ctx: writer })).rejects.toMatchObject({ code: "CONFLICT" });
            await expect(saas.createProject({ args: { name: "   " }, ctx: writer })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("gives a name with no letter or digit a slug of its own", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();

            await saas.createProject({ args: { name: "🚀" }, ctx: writer });
            await saas.createProject({ args: { name: "!!!" }, ctx: writer });

            const slugs = rows("saas_projects").map((row) => String(row["slug"]));

            expect(slugs.every((slug) => /^project-[0-9a-z]{7}$/u.test(slug))).toBe(true);
            expect(new Set(slugs).size).toBe(2);

            await expect(saas.createProject({ args: { name: "🚀" }, ctx: writer })).rejects.toMatchObject({ code: "CONFLICT" });
        });

        it("keeps two long names that share their first 60 characters apart", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();
            const prefix = "a".repeat(70);

            await saas.createProject({ args: { name: `${prefix} one` }, ctx: writer });
            await saas.createProject({ args: { name: `${prefix} two` }, ctx: writer });

            const slugs = rows("saas_projects").map((row) => String(row["slug"]));

            expect(new Set(slugs).size).toBe(2);
            expect(slugs.every((slug) => slug.length <= 60)).toBe(true);

            await expect(saas.createProject({ args: { name: `${prefix} one` }, ctx: writer })).rejects.toMatchObject({ code: "CONFLICT" });
        });

        it("frees the name of an archived project instead of reporting it as taken", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();
            const first = await saas.createProject({ args: { name: "Website" }, ctx: writer });

            await saas.archiveProject({ args: { projectId: first }, ctx: writer });
            await saas.createProject({ args: { name: "Website" }, ctx: writer });

            const slugs = rows("saas_projects").map((row) => row["slug"]);

            expect(slugs).toHaveLength(2);
            expect(slugs).toContain("website");
            expect(rows("saas_projects").find((row) => row["_id"] === first)!["archivedAt"]).toBeDefined();
        });

        it("stamps the activity row and the archive with the injected clock", async () => {
            expect.assertions(2);

            const { rows, saas, writer } = await setup();
            const projectId = await saas.createProject({ args: { name: "Website" }, ctx: writer });

            await saas.archiveProject({ args: { projectId }, ctx: writer });

            expect(rows("saas_activity").map((row) => row["createdAt"])).toStrictEqual([NOW, NOW]);
            expect(rows("saas_projects")[0]!["archivedAt"]).toBe(NOW);
        });

        it("refuses to write anywhere but the organisation's own shard", async () => {
            expect.assertions(2);

            const { rows, saas, writer } = await setup();

            await expect(saas.createProject({ args: { name: "Website" }, ctx: { ...writer, shardKey: "__root__" } })).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
            expect(rows("saas_projects")).toHaveLength(0);
        });

        it("still refuses the name of a live project", async () => {
            expect.assertions(1);

            const { saas, writer } = await setup();

            await saas.createProject({ args: { name: "Website" }, ctx: writer });

            await expect(saas.createProject({ args: { name: "website" }, ctx: writer })).rejects.toMatchObject({ code: "CONFLICT" });
        });
    });

    describe("syncOrganization", () => {
        const org = { name: "Acme", organizationId: "org-1", seats: 2, slug: "acme" };

        it("gives a deleted organisation's slug back to the next organisation", async () => {
            expect.assertions(2);

            const { rows, saas, writer } = await setup();

            await saas.syncOrganization({ args: org, ctx: writer });
            await saas.syncOrganization({ args: { ...org, seats: 0, status: "deleted" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Acme again", organizationId: "org-2", seats: 1, slug: "acme" }, ctx: writer });

            expect(rows("saas_organizations").find((row) => row["organizationId"] === "org-2")).toMatchObject({ slug: "acme", status: "active" });
            expect(rows("saas_organizations").find((row) => row["organizationId"] === "org-1")).toMatchObject({ status: "deleted" });
        });

        it("keeps a deleted organisation deleted when a member hook lands after it", async () => {
            expect.assertions(2);

            const { rows, saas, writer } = await setup();

            await saas.syncOrganization({ args: org, ctx: writer });
            await saas.syncOrganization({ args: { ...org, seats: 0, status: "deleted" }, ctx: writer });
            await saas.syncOrganization({ args: { ...org, seats: 1 }, ctx: writer });

            expect(rows("saas_organizations")).toHaveLength(1);
            expect(rows("saas_organizations")[0]).toMatchObject({ seats: 2, status: "deleted" });
        });

        it("tombstones an organisation it never saw, so a hook landing after the deletion cannot revive it", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            await saas.syncOrganization({ args: { ...org, seats: 0, status: "deleted" }, ctx: writer });
            await saas.syncOrganization({ args: { ...org, seats: 1 }, ctx: writer });

            expect(rows("saas_organizations")).toHaveLength(1);
            expect(rows("saas_organizations")[0]).toMatchObject({ slug: "~deleted~org-1", status: "deleted" });
            await expect(saas.listOrganizations({ args: { paginationOpts: { numItems: 10 } }, ctx: admin })).resolves.toMatchObject({ isDone: true, page: [] });
        });
    });

    describe("syncOrganizationPlan", () => {
        it("records the plan on a projected organisation and leaves a deleted or unknown one alone", async () => {
            expect.assertions(3);

            const { rows, saas, writer } = await setup();

            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", slug: "acme" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Gone", organizationId: "org-2", slug: "gone", status: "deleted" }, ctx: writer });
            await saas.syncOrganizationPlan({ args: { asOf: 1, organizationId: "org-1", plan: "pro" }, ctx: writer });
            await saas.syncOrganizationPlan({ args: { asOf: 1, organizationId: "org-2", plan: "pro" }, ctx: writer });
            await saas.syncOrganizationPlan({ args: { asOf: 1, organizationId: "org-3", plan: "pro" }, ctx: writer });

            expect(rows("saas_organizations").find((row) => row["organizationId"] === "org-1")).toMatchObject({ plan: "pro" });
            expect(rows("saas_organizations").find((row) => row["organizationId"] === "org-2")).toMatchObject({ plan: "free" });
            expect(rows("saas_organizations")).toHaveLength(2);
        });

        it("keeps the newer plan when an older derivation lands after it", async () => {
            expect.assertions(2);

            const { rows, saas, writer } = await setup();
            const plan = () => rows("saas_organizations")[0]!["plan"];

            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", slug: "acme" }, ctx: writer });
            // Billing moved free → pro → scale; the scale derivation lands first, the pro one last.
            await saas.syncOrganizationPlan({ args: { asOf: 20, organizationId: "org-1", plan: "scale" }, ctx: writer });
            await saas.syncOrganizationPlan({ args: { asOf: 10, organizationId: "org-1", plan: "pro" }, ctx: writer });

            expect(plan()).toBe("scale");

            await saas.syncOrganizationPlan({ args: { asOf: 30, organizationId: "org-1", plan: "free" }, ctx: writer });

            expect(plan()).toBe("free");
        });
    });

    describe("listOrganizations", () => {
        /** Five tenants with ties on seats and plan, each synced at its own time. */
        const seed = async () => {
            const context = await setup();
            const { saas, writer } = context;
            const tenants = [
                { name: "Globex", organizationId: "org-1", plan: "pro", seats: 3, slug: "globex" },
                { name: "Acme", organizationId: "org-2", plan: "free", seats: 12, slug: "acme-corp" },
                { name: "Initech", organizationId: "org-3", plan: "pro", seats: 12, slug: "initech" },
                { name: "Hooli", organizationId: "org-4", plan: "scale", seats: 40, slug: "hooli" },
                { name: "Umbrella", organizationId: "org-5", plan: "pro", seats: 3, slug: "umbrella" },
            ];

            for (const [index, tenant] of tenants.entries()) {
                // eslint-disable-next-line no-await-in-loop -- each sync stamps its own `now`, in order
                await saas.syncOrganization({ args: tenant, ctx: { ...writer, now: NOW + index } });
            }

            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            return { ...context, admin };
        };

        type Seeded = Awaited<ReturnType<typeof seed>>;

        /** Every page of a listing, followed through `continueCursor`. */
        const pageThrough = async ({ admin, saas }: Seeded, args: Omit<OrganizationListArgs, "paginationOpts">, numItems: number): Promise<unknown[]> => {
            const names: unknown[] = [];
            let cursor: string | null = null;

            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- a page's cursor comes from the one before it
                const result = await saas.listOrganizations({ args: { ...args, paginationOpts: { cursor, numItems } }, ctx: admin });

                names.push(...result.page.map((row) => row["name"]));

                if (result.isDone) {
                    return names;
                }

                expect(result.page).toHaveLength(numItems);

                cursor = result.continueCursor;
            }
        };

        it("leaves deleted organisations out of the admin list", async () => {
            expect.assertions(1);

            const { saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", seats: 2, slug: "acme" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Beta", organizationId: "org-2", seats: 1, slug: "beta" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", seats: 0, slug: "acme", status: "deleted" }, ctx: writer });

            const listed = await saas.listOrganizations({ args: { paginationOpts: { numItems: 10 } }, ctx: admin });

            expect(listed.page.map((row) => row["organizationId"])).toStrictEqual(["org-2"]);
        });

        it("pages through every organisation newest first, two at a time, without repeating or skipping one", async () => {
            expect.hasAssertions();

            const seeded = await seed();

            await expect(pageThrough(seeded, {}, 2)).resolves.toStrictEqual(["Umbrella", "Hooli", "Initech", "Acme", "Globex"]);
        });

        it("breaks a tie on the update time by organisation id, so a page boundary between two never moves", async () => {
            expect.hasAssertions();

            const seeded = await seed();
            const { saas, writer } = seeded;

            // Acme and Hooli now share one update time.
            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-2", slug: "acme-corp" }, ctx: { ...writer, now: NOW + 10 } });
            await saas.syncOrganization({ args: { name: "Hooli", organizationId: "org-4", slug: "hooli" }, ctx: { ...writer, now: NOW + 10 } });

            await expect(pageThrough(seeded, {}, 1)).resolves.toStrictEqual(["Hooli", "Acme", "Umbrella", "Initech", "Globex"]);
        });

        it("keeps a bounded page's range fixed, so a row landing inside it grows that page instead of shifting the next", async () => {
            expect.assertions(4);

            const seeded = await seed();
            const { admin, saas, writer } = seeded;
            const first = await saas.listOrganizations({ args: { paginationOpts: { numItems: 2 } }, ctx: admin });

            await saas.syncOrganization({ args: { name: "Aardvark", organizationId: "org-6", seats: 1, slug: "aardvark" }, ctx: { ...writer, now: NOW + 10 } });

            const grown = await saas.listOrganizations({
                args: { paginationOpts: { cursor: null, endCursor: first.continueCursor, numItems: 2 } },
                ctx: admin,
            });
            const next = await saas.listOrganizations({ args: { paginationOpts: { cursor: first.continueCursor, numItems: 2 } }, ctx: admin });

            expect(grown.page.map((row) => row["name"])).toStrictEqual(["Aardvark", "Umbrella", "Hooli"]);
            expect(grown).toMatchObject({ continueCursor: first.continueCursor, isDone: true });
            expect(grown.splitCursor).toStrictEqual(expect.any(String));
            expect(next.page.map((row) => row["name"])).toStrictEqual(["Initech", "Acme"]);
        });

        it("searches the name and slug as a case-insensitive substring, and filters by plan", async () => {
            expect.assertions(3);

            const seeded = await seed();

            await expect(pageThrough(seeded, { search: "CORP" }, 10)).resolves.toStrictEqual(["Acme"]);
            await expect(pageThrough(seeded, { search: "o" }, 10)).resolves.toStrictEqual(["Hooli", "Acme", "Globex"]);
            await expect(pageThrough(seeded, { plan: "pro" }, 10)).resolves.toStrictEqual(["Umbrella", "Initech", "Globex"]);
        });

        it("refuses a page size it cannot serve, rather than quietly serving less", async () => {
            expect.assertions(2);

            const { saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            await expect(saas.listOrganizations({ args: { paginationOpts: { numItems: 101 } }, ctx: admin })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
            await expect(saas.listOrganizations({ args: { paginationOpts: { numItems: 0 } }, ctx: admin })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("caps a re-read page that grew far past its size, and the client's splits still reach every row", async () => {
            expect.assertions(3);

            const { saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };
            const add = async (name: string, at: number) =>
                saas.syncOrganization({ args: { name, organizationId: `org-${name}`, slug: name }, ctx: { ...writer, now: NOW + at } });

            await add("a", 1);
            await add("b", 2);
            await add("c", 3);

            const first = await saas.listOrganizations({ args: { paginationOpts: { numItems: 2 } }, ctx: admin });

            // Twenty newer organisations land inside the loaded first page's range.
            for (let index = 0; index < 20; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- seeding, in order
                await add(`m${String(index).padStart(2, "0")}`, 10 + index);
            }

            const read = async (lower: string | null, upper: string): Promise<{ names: unknown[]; widest: number }> => {
                const result = await saas.listOrganizations({ args: { paginationOpts: { cursor: lower, endCursor: upper, numItems: 2 } }, ctx: admin });

                // What the client does: a page over twice its size is split at the server's midpoint.
                if (result.page.length > 2 * 2 && result.splitCursor) {
                    const [low, high] = await Promise.all([read(lower, result.splitCursor), read(result.splitCursor, upper)]);

                    return { names: [...low.names, ...high.names], widest: Math.max(result.page.length, low.widest, high.widest) };
                }

                return { names: result.page.map((row) => row["name"]), widest: result.page.length };
            };

            const { names, widest } = await read(null, first.continueCursor as string);

            expect(widest).toBe(4 * 2);
            expect(names).toHaveLength(22);
            expect(names).toStrictEqual([...Array.from({ length: 20 }, (_, index) => `m${String(19 - index).padStart(2, "0")}`), "c", "b"]);
        });

        it("refuses a cursor it did not mint", async () => {
            expect.assertions(2);

            const { admin, saas } = await seed();

            await expect(saas.listOrganizations({ args: { paginationOpts: { cursor: "not json", numItems: 2 } }, ctx: admin })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
            // The right length with the wrong key types: a name where the update time goes.
            await expect(
                saas.listOrganizations({ args: { paginationOpts: { cursor: JSON.stringify(["Acme", "org-2"]), numItems: 2 } }, ctx: admin }),
            ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("refuses everyone but a platform admin", async () => {
            expect.assertions(2);

            const { saas, writer } = await seed();

            await expect(saas.listOrganizations({ args: { paginationOpts: { numItems: 2 } }, ctx: writer })).rejects.toMatchObject({ code: "FORBIDDEN" });
            await expect(saas.organizationTotals({ args: {}, ctx: writer })).rejects.toMatchObject({ code: "FORBIDDEN" });
        });
    });

    describe("organizationTotals", () => {
        it("counts and sums seats over the whole filtered set, not a page of it", async () => {
            expect.assertions(4);

            const { saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", plan: "pro", seats: 12, slug: "acme" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Globex", organizationId: "org-2", plan: "pro", seats: 3, slug: "globex" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Hooli", organizationId: "org-3", plan: "free", seats: 1, slug: "hooli" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Gone", organizationId: "org-4", seats: 0, slug: "gone", status: "deleted" }, ctx: writer });

            await expect(saas.organizationTotals({ args: {}, ctx: admin })).resolves.toStrictEqual({ organizations: 3, seats: 16 });
            await expect(saas.organizationTotals({ args: { plan: "pro" }, ctx: admin })).resolves.toStrictEqual({ organizations: 2, seats: 15 });
            await expect(saas.organizationTotals({ args: { search: "nothing" }, ctx: admin })).resolves.toStrictEqual({ organizations: 0, seats: 0 });
            await expect(saas.organizationTotals({ args: { plan: "pro", search: "ACME" }, ctx: admin })).resolves.toStrictEqual({
                organizations: 1,
                seats: 12,
            });
        });
    });
});

describe("presence heartbeat", () => {
    type Heartbeat = Handler<{ data?: Row; roomId: string; sessionId: string }, { lastSeen: number }>;

    const NOW = 1_000_000;
    const TTL = 30_000;

    let heartbeat: Heartbeat;
    let database: ReturnType<typeof createDatabase>;

    beforeEach(async () => {
        ({ heartbeat } = await load<{ heartbeat: Heartbeat }>("registry", "presence", "presence.ts"));
        database = createDatabase({});

        const table = database.rows("presence_present");

        table.push(
            { _id: "p1", lastSeen: NOW - TTL - 1, roomId: "lobby", sessionId: "closed-tab", tenantId: "" },
            { _id: "p2", lastSeen: NOW - 1000, roomId: "lobby", sessionId: "open-tab", tenantId: "" },
            { _id: "p3", lastSeen: NOW - TTL - 1, roomId: "other-room", sessionId: "closed-tab", tenantId: "" },
        );
    });

    const call = async (sessionId: string) =>
        heartbeat({
            args: { roomId: "lobby", sessionId },
            ctx: { auth: { getIdentity: async () => null, userId: undefined }, db: database.db, ip: undefined, now: NOW },
        });

    it("reclaims the room's expired rows when a new session joins, and no other room's", async () => {
        expect.assertions(1);

        await call("new-tab");

        expect(
            database
                .rows("presence_present")
                .map((row) => `${String(row["sessionId"])}@${String(row["roomId"])}`)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["closed-tab@other-room", "new-tab@lobby", "open-tab@lobby"]);
    });

    it("reclaims a bounded batch, so a backlog cannot stop a new session joining", async () => {
        expect.assertions(2);

        const table = database.rows("presence_present");

        for (let index = 0; index < 120; index += 1) {
            table.push({ _id: `bulk-${String(index)}`, lastSeen: NOW - TTL - 1, roomId: "lobby", sessionId: `gone-${String(index)}`, tenantId: "" });
        }

        await call("new-tab");

        const lobby = database.rows("presence_present").filter((row) => row["roomId"] === "lobby");

        // 121 expired rows (the 120 plus `closed-tab`): 50 go, 71 wait for the next join or a sweep.
        expect(lobby.filter((row) => (row["lastSeen"] as number) <= NOW - TTL)).toHaveLength(71);
        expect(lobby.map((row) => row["sessionId"])).toContain("new-tab");
    });

    it("clears a session's awareness data when a heartbeat carries none", async () => {
        expect.assertions(2);

        const beat = async (data?: Row) =>
            heartbeat({
                args: { roomId: "lobby", sessionId: "open-tab", ...(data === undefined ? {} : { data }) },
                ctx: { auth: { getIdentity: async () => null, userId: undefined }, db: database.db, ip: undefined, now: NOW },
            });
        const row = () => database.rows("presence_present").find((entry) => entry["sessionId"] === "open-tab");

        await beat({ cursor: 3 });

        expect(row()?.["data"]).toStrictEqual({ cursor: 3 });

        await beat();

        expect(row()).not.toHaveProperty("data");
    });

    it("leaves expired rows alone on a re-heartbeat, which does not grow the room", async () => {
        expect.assertions(1);

        await call("open-tab");

        expect(database.rows("presence_present")).toHaveLength(3);
    });
});
