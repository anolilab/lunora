/**
 * Test entry-point Worker for the enterprise-auth (SSO / SCIM) workerd suites.
 *
 * Two things run through here.
 *
 * **What this worker imports** is the first. `@better-auth/scim` is zod-only, but
 * `@better-auth/sso` statically imports `samlify` (which itself `require`s `fs`,
 * `crypto`, and `zlib`) plus `node:crypto`'s `X509Certificate` — so the module graph
 * is pulled into the bundle even when only the OIDC code path is configured. If any
 * of that is unavailable in workerd, this worker fails to boot and the suite says so.
 *
 * **{@link AuthStorageDO}** is the second: better-auth running inside a Durable
 * Object, on the object's own SQLite. That is the only way to exercise
 * `lunoraDoAdapter` against the *real* `state.storage.transaction` — a Node suite can
 * only approximate it with BEGIN/COMMIT, which reproduces atomicity but not workerd's
 * dispatch isolation.
 */
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { getAuthTables } from "better-auth/db";

import { lunoraDoAdapter } from "../../src/adapter";
import { createAuth } from "../../src/create-auth";
import { handleAuthRequest } from "../../src/handler";
import { admin } from "../../src/plugins";

const SECRET = "lunora-workerd-do-secret-lunora-workerd-do-xx";

/** The credential the suite presents as the IdP. */
const SCIM_TOKEN = "workerd-do-scim-token"; // secret-scanner:allow

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: SCIM_TOKEN, type: "bearer" as const }], id: "okta-acme" }],
};

/** SQLite affinity for a better-auth field type. */
const affinity = (type: ReadonlyArray<string> | string): string => {
    if (type === "number") {
        return "REAL";
    }

    return type === "boolean" ? "INTEGER" : "TEXT";
};

/**
 * A Durable Object that hosts better-auth on its own SQLite.
 *
 * This is the shape an app would use: the object owns the auth tables, and
 * `lunoraDoAdapter(ctx.storage)` hands better-auth the object's storage — including
 * the transaction primitive that `@better-auth/scim` requires and D1 cannot provide.
 */
class AuthStorageDO {
    readonly #auth: ReturnType<typeof createAuth>;

    readonly #storage: DurableObjectState["storage"];

    #ready = false;

    public constructor(state: DurableObjectState) {
        this.#storage = state.storage;

        const options = { plugins: [scim(scimOptions), admin()], secret: SECRET };

        this.#auth = createAuth({ ...options, database: lunoraDoAdapter(state.storage) });
        this.#options = options;
    }

    readonly #options: { plugins: unknown[]; secret: string };

    /**
     * Create the auth tables on first use.
     *
     * `ensureMigrated` is not usable here — better-auth's migrator is kysely-only and
     * this object's storage is not a kysely dialect — so the schema is materialised
     * from `authTables` directly, which is what the object's own migration would do.
     */
    #ensureSchema(): void {
        if (this.#ready) {
            return;
        }

        for (const table of Object.values(getAuthTables(this.#options as never))) {
            const columns = [
                `"id" TEXT PRIMARY KEY`,
                ...Object.entries(table.fields).map(([field, attribute]) => `"${attribute.fieldName ?? field}" ${affinity(attribute.type)}`),
            ];

            this.#storage.sql.exec(`CREATE TABLE IF NOT EXISTS "${table.modelName}" (${columns.join(", ")})`);
        }

        // better-auth's rate limiter writes through the same store but is not part of
        // `authTables`, so it has to be created by hand.
        this.#storage.sql.exec('CREATE TABLE IF NOT EXISTS "rateLimit" ("id" TEXT PRIMARY KEY, "key" TEXT, "count" REAL, "lastRequest" REAL)');

        this.#ready = true;
    }

    /** Rows in the object's own `user` table, for the suite to assert against. */
    #users(): unknown[] {
        return [...this.#storage.sql.exec('SELECT "email" FROM "user"')];
    }

    public async fetch(request: Request): Promise<Response> {
        this.#ensureSchema();

        const url = new URL(request.url);

        if (url.pathname === "/__users") {
            return Response.json({ users: this.#users() });
        }

        const response = await handleAuthRequest(this.#auth, request);

        return response ?? new Response("not an auth route", { status: 404 });
    }
}

interface TestEnv {
    AUTH_DO: DurableObjectNamespace;
}

const testWorker = {
    async fetch(request: Request, env: TestEnv): Promise<Response> {
        const url = new URL(request.url);

        // Constructing the plugins (not just importing them) proves the factories
        // run — module-scope side effects in the samlify tree would already have
        // thrown by the time this worker booted.
        if (url.pathname === "/plugins") {
            const built = [sso(), scim({ connections: [{ credentials: [{ id: "primary", token: "unused", type: "bearer" }], id: "probe" }] })];

            return Response.json({ ids: built.map((plugin) => plugin.id) });
        }

        // Everything else goes to the object, so auth runs on DO storage.
        if (url.pathname.startsWith("/api/auth/") || url.pathname === "/__users") {
            const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName("auth"));

            return stub.fetch(request);
        }

        return new Response("auth-enterprise-test-worker", { status: 200 });
    },
};

export default testWorker;
// Exports last, per the repo's `import/exports-last` rule. `AuthStorageDO` is named
// by wrangler.jsonc's DO binding; `SCIM_TOKEN` is shared with the suite so the
// credential is declared once.
export { AuthStorageDO, SCIM_TOKEN };
