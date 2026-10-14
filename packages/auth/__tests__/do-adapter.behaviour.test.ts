import { DatabaseSync } from "node:sqlite";

import { getAuthTables } from "better-auth/db";
import { beforeEach, describe, expect, it } from "vitest";

import { lunoraD1Adapter, lunoraDoAdapter } from "../src/adapter";
import { createAuth } from "../src/create-auth";
import type { DoStorageLike } from "../src/do-store";
import { handleAuthRequest } from "../src/handler";
import { admin, scim } from "../src/plugins";

/**
 * The prototype Durable-Object-backed adapter, and the claim it exists to test:
 * **SCIM runs on a Durable Object's SQLite, where it cannot run on D1.**
 *
 * D1 has no interactive transactions, so `@better-auth/scim` rejects every D1-backed
 * adapter — the documented workaround is Postgres/MySQL via Hyperdrive. A Durable
 * Object's storage does have them (`state.storage.transaction`), so backing better-auth
 * with DO storage should satisfy the same plugin without leaving Cloudflare's
 * first-party stack. This suite checks that end to end, and contrasts it with the D1
 * adapter still being refused.
 *
 * The storage double below is `node:sqlite` with real `BEGIN`/`COMMIT`, which gives the
 * semantics that matter here: statements inside the closure join one transaction, and a
 * throw rolls all of them back. What it cannot model is workerd's dispatch isolation,
 * so this proves the adapter contract, not concurrency behaviour under load.
 */

const SECRET = "lunora-do-adapter-secret-lunora-do-adapter-xx";

const SCIM_TOKEN = "do-scim-token"; // secret-scanner:allow

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: SCIM_TOKEN, type: "bearer" as const }], id: "okta-acme" }],
};

let database: DatabaseSync;

/** SQLite affinity for a better-auth field type. */
const affinity = (type: ReadonlyArray<string> | string): string => {
    if (type === "number") {
        return "REAL";
    }

    return type === "boolean" ? "INTEGER" : "TEXT";
};

/** Create the better-auth tables for `options`, so the store reads and writes real rows. */
const materialiseSchema = (options: Parameters<typeof getAuthTables>[0]): void => {
    for (const table of Object.values(getAuthTables(options))) {
        const columns = [
            `"id" TEXT PRIMARY KEY`,
            ...Object.entries(table.fields).map(([field, attribute]) => `"${attribute.fieldName ?? field}" ${affinity(attribute.type)}`),
        ];

        database.exec(`CREATE TABLE IF NOT EXISTS "${table.modelName}" (${columns.join(", ")})`);
    }

    // better-auth's limiter writes through the same store but is not in `authTables`.
    database.exec('CREATE TABLE IF NOT EXISTS "rateLimit" ("id" TEXT PRIMARY KEY, "key" TEXT, "count" REAL, "lastRequest" REAL)');
};

/**
 * A `DurableObjectStorage` double over `node:sqlite`.
 *
 * `transaction` issues real `BEGIN`/`COMMIT`/`ROLLBACK` — which workerd forbids inside a
 * DO, hence the platform primitive there — so the *observable* contract matches: atomic,
 * and rolled back when the closure throws.
 */
const doStorage = (): DoStorageLike => {
    let depth = 0;

    return {
        sql: {
            exec: (query: string, ...bindings: unknown[]) => database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[],
        },
        transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
            if (depth > 0) {
                throw new Error("nested transactions are not supported");
            }

            depth = 1;
            database.exec("BEGIN");

            try {
                const result = await closure();

                database.exec("COMMIT");

                return result;
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            } finally {
                depth = 0;
            }
        },
    };
};

const scimRequest = (path: string, method: string, body?: unknown): Request =>
    new Request(`http://localhost/api/auth/scim/v2${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${SCIM_TOKEN}`, "content-type": "application/scim+json" },
        method,
    });

describe("lunoraDoAdapter", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
    });

    it("satisfies the SCIM plugin's transaction requirement", async () => {
        expect.assertions(2);

        const options = { plugins: [scim(scimOptions), admin()], secret: SECRET };

        materialiseSchema(options);

        const auth = createAuth({ ...options, database: lunoraDoAdapter(doStorage()) });
        const response = await handleAuthRequest(auth, scimRequest("/Users", "GET"));

        // The contrast with D1 is the whole point: the plugin serves rather than
        // rejecting the adapter, so we reach its credential check and get a real answer.
        expect(response?.status).toBe(200);
        await expect(response?.json()).resolves.toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"] });
    });

    it("provisions a user over SCIM into the object's own SQLite", async () => {
        expect.assertions(2);

        const options = { plugins: [scim(scimOptions), admin()], secret: SECRET };

        materialiseSchema(options);

        const auth = createAuth({ ...options, database: lunoraDoAdapter(doStorage()) });
        const created = await handleAuthRequest(
            auth,
            scimRequest("/Users", "POST", {
                active: true,
                emails: [{ primary: true, value: "ada@acme.test" }],
                schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
                userName: "ada@acme.test",
            }),
        );

        expect(created?.status).toBe(201);
        // Provisioning has to land in the DO's tables, not merely answer 201.
        expect(database.prepare('SELECT email FROM "user"').all()).toEqual([{ email: "ada@acme.test" }]);
    });

    it("rolls the whole transaction back when the closure throws", async () => {
        expect.assertions(2);

        materialiseSchema({ secret: SECRET });

        const storage = doStorage();

        await expect(
            storage.transaction(async () => {
                storage.sql.exec('INSERT INTO "user" ("id", "email") VALUES (?, ?)', "u1", "rolled@back.test");

                throw new Error("provisioning failed halfway");
            }),
        ).rejects.toThrow(/failed halfway/u);

        // Atomicity is the property SCIM is actually asking for, so assert it directly
        // rather than trusting the plugin's own checks.
        expect(database.prepare('SELECT count(*) AS total FROM "user"').all()).toEqual([{ total: 0 }]);
    });

    it("keeps the D1 adapter transaction-free, so SCIM still refuses it", async () => {
        expect.assertions(1);

        // The prototype must not have quietly changed the D1 path: SCIM's rejection there
        // is the documented behaviour the Hyperdrive guidance rests on.
        const d1Backed = createAuth({
            database: lunoraD1Adapter({ prepare: () => undefined } as never),
            plugins: [scim(scimOptions)],
            secret: SECRET,
        });

        await expect(handleAuthRequest(d1Backed, scimRequest("/Users", "GET"))).rejects.toThrow(/native transaction support/iu);
    });
});
