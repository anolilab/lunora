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
import { FUNCTION_PATH } from "../fixtures/registry-runtime/generated-internal";

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

    const find = (table: string, id: unknown): Row | undefined => rows(table).find((row) => row["_id"] === id);

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
            delete: async (table: string, id: unknown) => {
                const found = find(table, id);

                if (found) {
                    tables.set(
                        table,
                        rows(table).filter((row) => row !== found),
                    );
                }
            },
            get: async (table: string, id: unknown) => find(table, id) ?? null,
            insert: async (table: string, document: Row) => {
                counter += 1;

                const row = { ...document, _id: `${table}:${String(counter)}` };

                assertUnique(table, row);
                rows(table).push(row);

                return row["_id"];
            },
            patch: async (table: string, id: unknown, patch: Row) => {
                const found = find(table, id);

                if (!found) {
                    throw new Error(`no row ${String(id)} in ${table}`);
                }

                const next = { ...found, ...patch };

                assertUnique(table, next);
                Object.assign(found, patch);
            },
            replace: async (table: string, id: unknown, document: Row) => {
                const found = find(table, id);

                if (!found) {
                    throw new Error(`no row ${String(id)} in ${table}`);
                }

                const next = { ...document, _id: found["_id"] };

                assertUnique(table, next);
                tables.set(
                    table,
                    rows(table).map((row) => (row === found ? next : row)),
                );
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
    const NOW = 1_700_000_000_000;

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

    interface Payment {
        checkout: Checkout;
        holdCheckout: Handler<{ priceId: string; referenceId: string }, { holdId: string; sessionExpiresAt: number } | { url: string }>;
        settleCheckoutHold: Handler<{ holdId: string; url: string }, void>;
    }

    const NOW = 1_700_000_000_000;
    const SESSION_MS = 35 * 60_000;
    const HOLD_MS = SESSION_MS + 60_000;

    const setup = async (subscriptions: Row[], { checkoutExpiry = true } = {}) => {
        env["APP_BASE_URL"] = "https://app.example.test";

        const payment = await load<Payment>("templates", "saas", "lunora", "payment", "index.ts");
        const database = createDatabase({ checkout_holds: [["referenceId"]] });
        let sessions = 0;
        const createCheckout = vi.fn<(input: { email?: string; expiresAt?: number; idempotencyKey?: string }) => Promise<{ url: string }>>(async () => {
            sessions += 1;

            return { url: `https://pay.example.test/session-${String(sessions)}` };
        });
        const clock = { now: NOW };
        const auth = signedIn({ activeOrganizationId: "org-1", email: "owner@example.test", orgRole: "owner" });
        // The internal mutations run in the same shard, over the same database.
        const runMutation = async (reference: Record<typeof FUNCTION_PATH, string>, args: Row) => {
            const name = reference[FUNCTION_PATH].replace("payment.", "") as "holdCheckout" | "settleCheckoutHold";

            return (payment[name] as Handler<Row, unknown>)({ args, ctx: { db: database.db, now: clock.now } });
        };
        const ctx = {
            auth,
            payments: {
                adapter: { capabilities: { checkoutExpiry }, identifier: checkoutExpiry ? "stripe" : "polar" },
                createCheckout,
                listSubscriptions: vi.fn<() => Promise<Row[]>>(async () => subscriptions),
            },
            runMutation,
            shardKey: "__root__",
        };
        return { clock, createCheckout, ctx, database, payment };
    };

    it.each(["active", "trialing", "past_due", "paused"])("refuses a second subscription while one is %s", async (state) => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([{ state }]);

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("starts a checkout for an organisation with no live subscription", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([{ state: "canceled" }]);

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).resolves.toStrictEqual({ url: "https://pay.example.test/session-1" });
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("refuses to run off the root shard, where the billing tables are empty copies", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx: { ...ctx, shardKey: "org-1" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("refuses a provider that cannot expire the session, before taking a hold", async () => {
        expect.assertions(3);

        const { createCheckout, ctx, database, payment } = await setup([], { checkoutExpiry: false });

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
        expect(createCheckout).not.toHaveBeenCalled();
        expect(database.rows("checkout_holds")).toHaveLength(0);
    });

    it("hands the provider the caller's verified email for a first customer", async () => {
        expect.assertions(1);

        const { createCheckout, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        expect(createCheckout.mock.calls[0]![0].email).toBe("owner@example.test");
    });

    it("has the provider expire the session before the hold ends", async () => {
        expect.assertions(1);

        const { createCheckout, ctx, database, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        const sessionExpiresAt = createCheckout.mock.calls[0]![0].expiresAt;

        expect([sessionExpiresAt, database.rows("checkout_holds")[0]!["expiresAt"]]).toStrictEqual([NOW + SESSION_MS, NOW + HOLD_MS]);
    });

    it("refuses a checkout for another plan while one is in flight, before either webhook lands", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("hands a repeat for the same plan the session already started", async () => {
        expect.assertions(2);

        const { createCheckout, ctx, payment } = await setup([]);

        const first = await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).resolves.toStrictEqual(first);
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it("keeps the hold until it expires, and lets another plan start then", async () => {
        expect.assertions(2);

        const { clock, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        clock.now += HOLD_MS - 1;

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });

        clock.now += 2;

        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).resolves.toMatchObject({ url: "https://pay.example.test/session-2" });
    });

    it("starts a new session for the same plan once the hold has expired", async () => {
        expect.assertions(1);

        const { clock, ctx, payment } = await setup([]);

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        clock.now += HOLD_MS + 1;

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).resolves.toStrictEqual({ url: "https://pay.example.test/session-2" });
    });

    it("leaves a newer hold alone when a stale provider call settles", async () => {
        expect.assertions(2);

        const { clock, ctx, database, payment } = await setup([]);
        const stale = await payment.holdCheckout({ args: { priceId: "price_pro", referenceId: "org-1" }, ctx: { db: database.db, now: clock.now } });

        clock.now += HOLD_MS + 1;

        await payment.checkout({ args: { priceId: "price_scale" }, ctx });
        await payment.settleCheckoutHold({
            args: { holdId: (stale as { holdId: string }).holdId, url: "https://pay.example.test/stale" },
            ctx: { db: database.db, now: clock.now },
        });

        expect(database.rows("checkout_holds")).toHaveLength(1);
        expect(database.rows("checkout_holds")[0]).toMatchObject({ priceId: "price_scale", url: "https://pay.example.test/session-1" });
    });

    it("keeps the hold when the provider call fails, and retries the same plan under the same key", async () => {
        expect.assertions(5);

        const { createCheckout, ctx, database, payment } = await setup([]);

        createCheckout.mockRejectedValueOnce(new Error("provider timed out"));

        await expect(payment.checkout({ args: { priceId: "price_pro" }, ctx })).rejects.toThrow("provider timed out");
        expect(database.rows("checkout_holds")).toHaveLength(1);
        // The session may exist after all, so another plan must still wait for the hold.
        await expect(payment.checkout({ args: { priceId: "price_scale" }, ctx })).rejects.toMatchObject({ code: "CONFLICT" });

        await payment.checkout({ args: { priceId: "price_pro" }, ctx });

        const keys = createCheckout.mock.calls.map(([input]) => (input as { idempotencyKey?: string }).idempotencyKey);

        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
    });
});

describe("saas template admin subscriptions", () => {
    type AdminSubscriptions = Handler<Row, Row[]>;

    const setup = async (claims: Row) => {
        env["APP_BASE_URL"] = "https://app.example.test";

        const { adminSubscriptions } = await load<{ adminSubscriptions: AdminSubscriptions }>("templates", "saas", "lunora", "payment", "index.ts");
        const database = createDatabase({});

        database
            .rows("payment_subscriptions")
            .push({ _id: "s1", priceId: "price_pro", providerSubscriptionId: "sub_1", referenceId: "org-1", state: "active" });

        return { adminSubscriptions, ctx: { auth: signedIn(claims), db: database.db, shardKey: "__root__" } };
    };

    it("refuses a platform admin on a tenant shard instead of reading its empty copy", async () => {
        expect.assertions(1);

        const { adminSubscriptions, ctx } = await setup({ appRole: "admin" });

        await expect(adminSubscriptions({ args: {}, ctx: { ...ctx, shardKey: "org-1" } })).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining("root shard"),
        });
    });

    it("refuses anyone without the platform admin role", async () => {
        expect.assertions(1);

        const { adminSubscriptions, ctx } = await setup({ appRole: "user" });

        await expect(adminSubscriptions({ args: {}, ctx })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("platform admin") });
    });

    it("reads the root shard's subscriptions for a platform admin", async () => {
        expect.assertions(1);

        const { adminSubscriptions, ctx } = await setup({ appRole: "user,admin" });

        await expect(adminSubscriptions({ args: {}, ctx })).resolves.toMatchObject([{ providerSubscriptionId: "sub_1", referenceId: "org-1" }]);
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

    it("clears a session's awareness data when a heartbeat carries none", async () => {
        expect.assertions(2);

        const beat = async (data?: Row) =>
            heartbeat({
                args: { roomId: "lobby", sessionId: "open-tab", ...(data === undefined ? {} : { data }) },
                ctx: { auth: { userId: undefined }, db: database.db, ip: undefined, now: NOW },
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
