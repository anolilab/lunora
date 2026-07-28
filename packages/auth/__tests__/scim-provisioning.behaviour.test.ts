import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { lunoraD1Adapter, lunoraDoAdapter } from "../src/adapter";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { authDoSchemaStatements } from "../src/do-schema";
import { handleAuthRequest } from "../src/handler";
import { admin, scim } from "../src/plugins";
import createDoStorage from "./helpers/do-storage";

/**
 * The SCIM **provisioning lifecycle**, driven through the real endpoints against a
 * real database.
 *
 * The enterprise suite next door covers schema derivation and request routing — that a
 * request reaches SCIM and that credentials are enforced. It never proved provisioning
 * itself does anything, so this suite asserts the rows an IdP's calls actually move.
 *
 * Two of those answers are not what this feature's docs originally claimed, which is
 * exactly why they are pinned here: deactivating a user does **not** ban the account
 * (1.7 keeps SCIM state in its own projection and never writes `banned`), and `DELETE`
 * removes the SCIM resource while leaving the account row in place.
 *
 * ## Why the DO adapter is the substrate
 *
 * `scim()` refuses to serve unless the adapter exposes native transactions, which rules
 * out `lunoraD1Adapter` (single-table CRUD over `ctx.db`, and D1 has no interactive
 * transactions anyway). `lunoraDoAdapter` does expose them, and needs no kysely dialect —
 * which also keeps this suite off `@better-auth/kysely-adapter`'s node-sqlite dialect,
 * whose `StatementSync.columns()` call requires a newer Node than this package supports.
 * The `node:sqlite` calls made here (`prepare().all()`, `exec()`) exist on 22.15.
 *
 * The constraint itself is pinned by a test below rather than left as folklore.
 */

const SECRET = "lunora-scim-lifecycle-secret-lunora-scim-xx";

/** The bearer credential the IdP presents. Config-declared — 1.7 stores no token at rest. */
const SCIM_TOKEN = "scim-lifecycle-token"; // secret-scanner:allow

/** A second credential, scoped to reads only, for the authorization test below. */
const READ_ONLY_TOKEN = "scim-read-only-token"; // secret-scanner:allow

const CONNECTION_ID = "okta-acme";

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: SCIM_TOKEN, type: "bearer" as const }], id: CONNECTION_ID }],
};

/** The subset of a SCIM User resource these assertions read. */
interface ScimUser {
    active: boolean;
    id: string;
    userName: string;
}

/** SCIM's list envelope. */
interface ScimList {
    Resources: unknown[];
    schemas: string[];
}

type ScimPayload = ScimList | ScimUser | undefined;

let database: DatabaseSync;
let auth: ReturnType<typeof createAuth>;

/**
 * Create the auth tables for `options`.
 *
 * Uses the package's own DDL rather than a local mirror of it — that helper emits the
 * UNIQUE indexes better-auth expresses outside the column definitions, so this suite
 * runs against the same constraints a real deployment has. An earlier local copy here
 * created columns only, which would have let a duplicate-provisioning bug pass.
 */
const materialiseSchema = (options: Parameters<typeof authDoSchemaStatements>[0]): void => {
    for (const statement of authDoSchemaStatements(resolveAuthOptions(options))) {
        database.exec(statement);
    }
};

/** A SCIM request carrying the configured credential. */
const scimRequest = (path: string, method: string, body?: unknown): Request =>
    new Request(`http://localhost/api/auth/scim/v2${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${SCIM_TOKEN}`, "content-type": "application/scim+json" },
        method,
    });

/** Drive a SCIM request through Lunora's dispatch and decode the response. */
const callScim = async (path: string, method: string, body?: unknown): Promise<{ payload: ScimPayload; status: number }> => {
    const response = await handleAuthRequest(auth, scimRequest(path, method, body));

    if (!response) {
        throw new Error(`${method} ${path} was not routed to the auth handler`);
    }

    const text = await response.text();

    return { payload: (text === "" ? undefined : JSON.parse(text)) as ScimPayload, status: response.status };
};

/** Narrow to a User resource, failing loudly rather than casting blind. */
const asUser = (payload: ScimPayload): ScimUser => {
    if (payload === undefined || !("userName" in payload)) {
        throw new Error(`expected a SCIM User resource, got ${JSON.stringify(payload)}`);
    }

    return payload;
};

/** Narrow to a list envelope. */
const asList = (payload: ScimPayload): ScimList => {
    if (payload === undefined || !("Resources" in payload)) {
        throw new Error(`expected a SCIM list response, got ${JSON.stringify(payload)}`);
    }

    return payload;
};

/** Provision a user over SCIM and return the created resource. */
const provision = async (userName: string): Promise<ScimUser> => {
    const created = await callScim("/Users", "POST", {
        active: true,
        emails: [{ primary: true, value: userName }],
        externalId: `ext-${userName}`,
        name: { familyName: "Lovelace", givenName: "Ada" },
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName,
    });

    return asUser(created.payload);
};

/** Set a provisioned user's `active` flag the way an IdP does. */
const setActive = async (id: string, value: boolean): Promise<number> => {
    const patched = await callScim(`/Users/${id}`, "PATCH", {
        Operations: [{ op: "replace", path: "active", value }],
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    });

    return patched.status;
};

/** Rows in the account table a SCIM operation may or may not have touched. */
const userRows = (): Record<string, unknown>[] => database.prepare('SELECT * FROM "user"').all();

const scimUserCount = (): unknown => {
    const rows = database.prepare('SELECT count(*) AS total FROM "scimUser"').all();

    return rows[0]?.["total"];
};

describe("scim provisioning lifecycle", () => {
    beforeEach(async () => {
        database = new DatabaseSync(":memory:");

        const options = {
            baseURL: "http://localhost",
            emailAndPassword: { enabled: true },
            // `admin` is loaded because an app running SCIM realistically has it — not
            // because SCIM needs it. Contrary to the 1.6-era guidance, 1.7's deactivation
            // does not route through the admin plugin's ban mechanics at all.
            plugins: [scim(scimOptions), admin()],
            secret: SECRET,
        };

        materialiseSchema(options);

        // `lunoraDoAdapter` is what satisfies the SCIM plugin's transaction requirement.
        auth = createAuth({ ...options, database: lunoraDoAdapter(createDoStorage(database)) });
    });

    it("creates an account in the database from a SCIM POST", async () => {
        expect.assertions(4);

        const created = await callScim("/Users", "POST", {
            active: true,
            emails: [{ primary: true, value: "ada@acme.test" }],
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: "ada@acme.test",
        });

        expect(created.status).toBe(201);
        expect(asUser(created.payload)).toMatchObject({ active: true, userName: "ada@acme.test" });

        // The point of the suite: provisioning wrote an account, not merely answered 201.
        const rows = userRows();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ email: "ada@acme.test" });
    });

    it("lists provisioned users in SCIM's list envelope", async () => {
        expect.assertions(3);

        await provision("grace@acme.test");

        const listed = await callScim("/Users", "GET");

        expect(listed.status).toBe(200);
        expect(asList(listed.payload)).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"] });
        expect(asList(listed.payload).Resources).toHaveLength(1);
    });

    it("fetches a provisioned user by its SCIM id", async () => {
        expect.assertions(2);

        const created = await provision("ada@acme.test");
        const fetched = await callScim(`/Users/${created.id}`, "GET");

        expect(fetched.status).toBe(200);
        expect(asUser(fetched.payload)).toMatchObject({ id: created.id, userName: "ada@acme.test" });
    });

    it("deactivates a user through a SCIM PATCH — without banning the account", async () => {
        expect.assertions(3);

        const created = await provision("ada@acme.test");
        const status = await setActive(created.id, false);

        // 204, no body: SCIM's mutation responses here are empty.
        expect(status).toBe(204);

        const reread = await callScim(`/Users/${created.id}`, "GET");

        expect(asUser(reread.payload)).toMatchObject({ active: false });
        // The load-bearing assertion. 1.7 records deactivation in its own projection and
        // never writes `banned`, so an IdP disabling a user does NOT stop them signing in.
        // Cutting off access is the app's job, off the projection.
        expect(userRows()[0]).toMatchObject({ banned: 0 });
    });

    it("reactivates a previously deactivated user", async () => {
        expect.assertions(2);

        const created = await provision("ada@acme.test");

        await setActive(created.id, false);
        await setActive(created.id, true);

        const reread = await callScim(`/Users/${created.id}`, "GET");

        expect(asUser(reread.payload)).toMatchObject({ active: true });
        expect(userRows()).toHaveLength(1);
    });

    it("applies a rename through a SCIM PUT", async () => {
        expect.assertions(2);

        const created = await provision("ada@acme.test");
        const replaced = await callScim(`/Users/${created.id}`, "PUT", {
            active: true,
            emails: [{ primary: true, value: "ada.lovelace@acme.test" }],
            name: { familyName: "Lovelace", givenName: "Augusta" },
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: "ada.lovelace@acme.test",
        });

        expect(replaced.status).toBe(200);
        // A rename has to land in the row the app reads, not only in the SCIM projection.
        expect(userRows()[0]).toMatchObject({ name: "Augusta Lovelace" });
    });

    it("removes the SCIM resource on DELETE, leaving the account row", async () => {
        expect.assertions(3);

        const created = await provision("ada@acme.test");
        const deleted = await callScim(`/Users/${created.id}`, "DELETE");

        expect(deleted.status).toBe(204);
        // The SCIM resource is gone…
        expect(scimUserCount()).toBe(0);
        // …but the account is NOT deleted. An IdP removing a user from its directory
        // unlinks them here; treating DELETE as an off-boarding guarantee would be wrong.
        expect(userRows()).toHaveLength(1);
    });

    it("refuses a write when the credential lacks the write scope", async () => {
        expect.assertions(1);

        const readOnly = createAuth({
            baseURL: "http://localhost",
            database: lunoraDoAdapter(createDoStorage(database)),
            plugins: [
                scim({
                    connections: [
                        { credentials: [{ id: "ro", scopes: ["scim.users.read"], token: READ_ONLY_TOKEN, type: "bearer" as const }], id: CONNECTION_ID },
                    ],
                }),
                admin(),
            ],
            secret: SECRET,
        });

        const response = await handleAuthRequest(
            readOnly,
            new Request("http://localhost/api/auth/scim/v2/Users", {
                body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "mallory@acme.test" }),
                headers: { authorization: `Bearer ${READ_ONLY_TOKEN}`, "content-type": "application/scim+json" },
                method: "POST",
            }),
        );

        // Scopes are the only thing between a read-only directory sync and one that can
        // create accounts, so a read token must not be able to provision.
        expect(response?.status).toBe(403);
    });
});

describe("scim adapter requirement", () => {
    it("refuses to serve on Lunora's own adapter, which has no native transactions", async () => {
        expect.assertions(1);

        // Pins a constraint otherwise rediscovered the hard way: `lunoraD1Adapter` (and
        // `lunoraAuthAdapter` beneath it) is single-table CRUD over `ctx.db`, so the SCIM
        // plugin rejects it. The rejection is asynchronous — `createAuth` returns and the
        // plugin fails when the adapter is first resolved — so it surfaces on use.
        const unsupported = createAuth({
            database: lunoraD1Adapter({ prepare: () => undefined } as never),
            plugins: [scim(scimOptions)],
            secret: SECRET,
        });

        await expect(handleAuthRequest(unsupported, scimRequest("/Users", "GET"))).rejects.toThrow(/native transaction support/iu);
    });
});
