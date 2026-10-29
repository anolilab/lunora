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
 *
 * **{@link OrgAuthDO}** is the same subclass with the organization plugin (teams on)
 * and email/password sign-in, so the identity route's membership reads (`member`,
 * `team`, `teamMember`) and the organization cache-cookie refresh run on workerd's
 * SQLite. A separate object, so the tables it adds stay out of the suites that
 * assert {@link AuthStorageDO}'s schema and move order.
 */
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { organization } from "better-auth/plugins/organization";

import { LunoraAuthDO, RESOLVE_SESSION_PATH } from "../../src/auth-do";
import { admin } from "../../src/plugins";

const SECRET = "lunora-workerd-do-secret-lunora-workerd-do-xx";

/** {@link OrgAuthDO}'s base URL; https, so its cookies carry the `__Secure-` prefix. */
const ORG_AUTH_ORIGIN = "https://example.test";

/** The credential the suite presents as the IdP. */
const SCIM_TOKEN = "workerd-do-scim-token"; // secret-scanner:allow

/** The secret the worker presents on the auth DO's internal session route. */
const INTERNAL_SECRET = "workerd-do-internal-secret"; // secret-scanner:allow

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: SCIM_TOKEN, type: "bearer" as const }], id: "okta-acme" }],
};

/**
 * The app's auth Durable Object.
 *
 * This is the shape codegen emits and an app writes by hand: a thin subclass of
 * {@link LunoraAuthDO}, which owns the schema materialisation, the better-auth
 * instance over `lunoraDoAdapter(state.storage)`, and the internal session route.
 *
 * Deliberately thin. When the suite exercised a hand-rolled copy of that logic
 * instead, it proved the copy worked rather than the package — including a schema
 * materialiser that created no UNIQUE indexes at all.
 */
class AuthStorageDO extends LunoraAuthDO {
    readonly #storage: DurableObjectState["storage"];

    public constructor(state: DurableObjectState) {
        super(
            state,
            () => {
                return { plugins: [scim(scimOptions), admin()], secret: SECRET };
            },
            { internalSecret: INTERNAL_SECRET },
        );
        this.#storage = state.storage;
    }

    /** Rows in the object's own `user` table, for the suite to assert against. */
    #users(): unknown[] {
        return [...this.#storage.sql.exec('SELECT "email" FROM "user"')];
    }

    public override async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === "/__users") {
            return Response.json({ users: this.#users() });
        }

        return super.fetch(request);
    }
}

/** The app's auth Durable Object with organizations and teams. */
class OrgAuthDO extends LunoraAuthDO {
    public constructor(state: DurableObjectState) {
        super(
            state,
            () => {
                // `session.cookieCache` is left to `createAuth`'s default (on), which is what
                // makes the organization endpoints' cache-cookie refresh observable.
                return {
                    baseURL: ORG_AUTH_ORIGIN,
                    emailAndPassword: { enabled: true },
                    plugins: [organization({ teams: { enabled: true } })],
                    rateLimit: { enabled: false },
                    secret: SECRET,
                };
            },
            { internalSecret: INTERNAL_SECRET },
        );
    }
}

interface TestEnv {
    AUTH_DO: DurableObjectNamespace;
    /** Driven directly from `cloudflare:test`, one object per spec, not through this worker. */
    ORG_AUTH_DO: DurableObjectNamespace;
    /** Used by the D1 migration suite directly from `cloudflare:test`, not by this worker. */
    TEST_DB: D1Database;
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

        // Everything else goes to the object, so auth runs on DO storage. The
        // internal session path is forwarded too — that is the hop the generated
        // worker's `resolveIdentity` makes.
        if (url.pathname.startsWith("/api/auth/") || url.pathname === "/__users" || url.pathname === RESOLVE_SESSION_PATH) {
            const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName("auth"));

            return stub.fetch(request);
        }

        return new Response("auth-enterprise-test-worker", { status: 200 });
    },
};

export default testWorker;
// Exports last, per the repo's `import/exports-last` rule. `AuthStorageDO`
// and `OrgAuthDO` are named by wrangler.jsonc's DO bindings; the constants are shared
// with the suites so each credential is declared once.
export type { TestEnv };
export { AuthStorageDO, INTERNAL_SECRET, ORG_AUTH_ORIGIN, OrgAuthDO, SCIM_TOKEN, SECRET };
