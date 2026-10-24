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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../fixtures/registry-runtime/cloudflare-workers";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

type Row = Record<string, unknown>;
type Handler<TArgs, TResult> = (invocation: { args: TArgs; ctx: unknown }) => Promise<TResult>;

/** Load an item through a computed specifier, so this package's `tsc` never sees its aliased imports. */
const load = async <T>(...segments: string[]): Promise<T> => (await import(pathToFileURL(join(root, ...segments)).href)) as T;

/**
 * An in-memory `ctx.db` over named tables with the unique indexes the kit
 * declares. A duplicate on a unique index throws, as the real engine does.
 */
/** A row predicate: every bound field equals its value. */
const equalsAll =
    (bound: Row) =>
    (row: Row): boolean =>
        Object.entries(bound).every(([field, value]) => row[field] === value);

const createDatabase = (unique: Record<string, string[][]>) => {
    const tables = new Map<string, Row[]>();
    let counter = 0;

    const rows = (table: string): Row[] => {
        if (!tables.has(table)) {
            tables.set(table, []);
        }

        return tables.get(table)!;
    };

    const match = (row: Row, where: Row): boolean =>
        Object.entries(where).every(([field, condition]) => {
            if (typeof condition === "object" && condition !== null && "ne" in condition) {
                return row[field] !== condition.ne;
            }

            return row[field] === condition;
        });

    const assertUnique = (table: string, candidate: Row): void => {
        for (const fields of unique[table] ?? []) {
            const clash = rows(table).find((row) => row["_id"] !== candidate["_id"] && fields.every((field) => row[field] === candidate[field]));

            if (clash) {
                throw new Error(`UNIQUE constraint failed: ${table}.${fields.join(", ")}`);
            }
        }
    };

    const find = (id: unknown): { row: Row; table: string } | undefined => {
        for (const [table, list] of tables) {
            const row = list.find((entry) => entry["_id"] === id);

            if (row) {
                return { row, table };
            }
        }

        return undefined;
    };

    const facade = (table: string) => {
        return {
            findFirst: async ({ where }: { where: Row }) => rows(table).find((row) => match(row, where)) ?? null,
            findMany: async ({ where = {} }: { where?: Row }) => {
                return { page: rows(table).filter((row) => match(row, where)) };
            },
        };
    };

    return {
        db: {
            delete: async (id: unknown) => {
                const found = find(id);

                if (found) {
                    tables.set(
                        found.table,
                        rows(found.table).filter((row) => row !== found.row),
                    );
                }
            },
            get: async (id: unknown) => find(id)?.row ?? null,
            insert: async (table: string, document: Row) => {
                counter += 1;

                const row = { ...document, _id: `${table}:${String(counter)}` };

                assertUnique(table, row);
                rows(table).push(row);

                return row["_id"];
            },
            patch: async (id: unknown, patch: Row) => {
                const found = find(id);

                if (!found) {
                    throw new Error(`no row ${String(id)}`);
                }

                const next = { ...found.row, ...patch };

                assertUnique(found.table, next);
                Object.assign(found.row, patch);
            },
            query: (table: string) => {
                let predicate = (_row: Row) => true;

                const query = {
                    collect: async () => rows(table).filter((row) => predicate(row)),
                    filter: (callback: (row: Row) => boolean) => {
                        const previous = predicate;

                        predicate = (row) => previous(row) && callback(row);

                        return query;
                    },
                    first: async () => rows(table).find((row) => predicate(row)) ?? null,
                    take: async (limit: number) =>
                        rows(table)
                            .filter((row) => predicate(row))
                            .slice(0, limit),
                    withIndex: (_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
                        const bound: Row = {};
                        const q = {
                            eq: (field: string, value: unknown) => {
                                bound[field] = value;

                                return q;
                            },
                        };

                        build(q);
                        predicate = equalsAll(bound);

                        return query;
                    },
                };

                return query;
            },
            saas_organizations: facade("saas_organizations"),
        },
        rows,
    };
};

const signedIn = (claims: Row) => {
    return {
        getIdentity: async () => claims,
    };
};

describe("saas kit functions", () => {
    interface Saas {
        archiveProject: Handler<Record<"projectId", string>, void>;
        createProject: Handler<{ name: string }, string>;
        listOrganizations: (invocation: { ctx: unknown }) => Promise<Row[]>;
        syncOrganization: Handler<{ name: string; organizationId: string; seats?: number; slug: string; status?: string }, void>;
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
        };

        return { db, rows, saas, writer };
    };

    describe("createProject", () => {
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
            await expect(saas.listOrganizations({ ctx: admin })).resolves.toStrictEqual([]);
        });
    });

    describe("listOrganizations", () => {
        it("leaves deleted organisations out of the admin list", async () => {
            expect.assertions(1);

            const { saas, writer } = await setup();
            const admin = { ...writer, auth: { ...signedIn({ appRole: "admin" }), userId: "admin-1" } };

            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", seats: 2, slug: "acme" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Beta", organizationId: "org-2", seats: 1, slug: "beta" }, ctx: writer });
            await saas.syncOrganization({ args: { name: "Acme", organizationId: "org-1", seats: 0, slug: "acme", status: "deleted" }, ctx: writer });

            const listed = await saas.listOrganizations({ ctx: admin });

            expect(listed.map((row) => row["organizationId"])).toStrictEqual(["org-2"]);
        });
    });
});

describe("saas template checkout", () => {
    type Checkout = Handler<{ priceId: string }, { url: string }>;

    const setup = async (subscriptions: Row[]) => {
        env["APP_BASE_URL"] = "https://app.example.test";

        const { checkout } = await load<{ checkout: Checkout }>("templates", "saas", "lunora", "payment", "index.ts");
        const createCheckout = vi.fn<() => Promise<{ url: string }>>(async () => {
            return { url: "https://pay.example.test/session" };
        });
        const ctx = {
            auth: signedIn({ activeOrganizationId: "org-1", orgRole: "owner" }),
            payments: { createCheckout, listSubscriptions: vi.fn<() => Promise<Row[]>>(async () => subscriptions) },
        };

        return { checkout, createCheckout, ctx };
    };

    it.each(["active", "trialing", "past_due", "paused"])("refuses a second subscription while one is %s", async (state) => {
        expect.assertions(2);

        const { checkout, createCheckout, ctx } = await setup([{ state }]);

        await expect(checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("starts a checkout for an organisation with no live subscription", async () => {
        expect.assertions(2);

        const { checkout, createCheckout, ctx } = await setup([{ state: "canceled" }]);

        await expect(checkout({ args: { priceId: "price_scale" }, ctx })).resolves.toStrictEqual({ url: "https://pay.example.test/session" });
        expect(createCheckout).toHaveBeenCalledTimes(1);
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
            { _id: "p1", lastSeen: NOW - TTL - 1, roomId: "lobby", sessionId: "closed-tab" },
            { _id: "p2", lastSeen: NOW - 1000, roomId: "lobby", sessionId: "open-tab" },
            { _id: "p3", lastSeen: NOW - TTL - 1, roomId: "other-room", sessionId: "closed-tab" },
        );
    });

    const call = async (sessionId: string) =>
        heartbeat({
            args: { roomId: "lobby", sessionId },
            ctx: { auth: { userId: undefined }, db: database.db, ip: undefined, now: NOW },
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
            table.push({ _id: `bulk-${String(index)}`, lastSeen: NOW - TTL - 1, roomId: "lobby", sessionId: `gone-${String(index)}` });
        }

        await call("new-tab");

        const lobby = database.rows("presence_present").filter((row) => row["roomId"] === "lobby");

        // 121 expired rows (the 120 plus `closed-tab`): 50 go, 71 wait for the next join or a sweep.
        expect(lobby.filter((row) => (row["lastSeen"] as number) <= NOW - TTL)).toHaveLength(71);
        expect(lobby.map((row) => row["sessionId"])).toContain("new-tab");
    });

    it("leaves expired rows alone on a re-heartbeat, which does not grow the room", async () => {
        expect.assertions(1);

        await call("open-tab");

        expect(database.rows("presence_present")).toHaveLength(3);
    });
});
