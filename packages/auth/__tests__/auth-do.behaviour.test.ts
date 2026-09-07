import { DatabaseSync } from "node:sqlite";

import { scim } from "@better-auth/scim";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthDoOptions } from "../src/auth-do";
import { INTERNAL_SECRET_HEADER, LunoraAuthDO, READ_AUDIT_PATH, RESOLVE_SESSION_PATH } from "../src/auth-do";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createDoAuthWiring } from "../src/do-wiring";
import { admin } from "../src/plugins";
import createDoStorage from "./helpers/do-storage";

/**
 * `LunoraAuthDO` — better-auth hosted inside a Durable Object.
 *
 * Two things are worth proving here beyond "it responds". First, the object
 * materialises its own schema: better-auth's migrator is kysely-only, so if that
 * step is wrong there are no tables and every route fails at the first write.
 * Second, the internal session route is the object's only non-`/api/auth/*`
 * surface and it answers identity questions — so its credential check is a real
 * authorization boundary, not a formality, and it is asserted as one.
 */

const SECRET = "lunora-auth-do-secret-lunora-auth-do-xxxx";

/** The secret the worker presents on the internal route. */
const INTERNAL_SECRET = "auth-do-internal-secret"; // secret-scanner:allow

/** The bearer credential the IdP presents to SCIM. */
const SCIM_TOKEN = "auth-do-scim-token"; // secret-scanner:allow

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: SCIM_TOKEN, type: "bearer" as const }], id: "okta-acme" }],
};

let database: DatabaseSync;

/** Build a DO instance over a fresh in-memory database. */
const createDo = (options: Partial<LunoraAuthOptions> = {}, doOptions?: AuthDoOptions): { authDo: LunoraAuthDO; factory: ReturnType<typeof vi.fn> } => {
    const factory = vi.fn<() => LunoraAuthOptions>(() => {
        return { secret: SECRET, ...options };
    });
    const authDo = new LunoraAuthDO({ storage: createDoStorage(database) }, factory, doOptions ?? { internalSecret: INTERNAL_SECRET });

    return { authDo, factory };
};

/** Call the internal session route with an optional secret header. */
const resolveSession = async (authDo: LunoraAuthDO, headers: Record<string, string> = {}): Promise<Response> =>
    authDo.fetch(new Request(`https://example.test${RESOLVE_SESSION_PATH}`, { headers }));

describe("lunoraAuthDO", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
    });

    it("materialises its own schema, so the first request has tables to write to", async () => {
        expect.assertions(2);

        const { authDo } = createDo({ plugins: [scim(scimOptions), admin()] });

        // Before any request the object has done nothing — the build is lazy.
        expect(database.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).get()?.n).toBe(0);

        await authDo.fetch(new Request("https://example.test/api/auth/scim/v2/Users", { headers: { authorization: `Bearer ${SCIM_TOKEN}` } }));

        const tables = database
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((row) => String(row.name));

        expect(tables).toStrictEqual(expect.arrayContaining(["account", "session", "user"]));
    });

    it("serves SCIM, which is the whole reason the tables live in a DO", async () => {
        expect.assertions(2);

        const { authDo } = createDo({ plugins: [scim(scimOptions), admin()] });

        const response = await authDo.fetch(new Request("https://example.test/api/auth/scim/v2/Users", { headers: { authorization: `Bearer ${SCIM_TOKEN}` } }));

        // On D1 this never gets past "requires a database adapter with native
        // transaction support" — the DO's transaction is what makes it a 200.
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"] });
    });

    it("builds the auth instance once, not per request", async () => {
        expect.assertions(1);

        const { authDo, factory } = createDo();

        await authDo.fetch(new Request("https://example.test/api/auth/get-session"));
        await authDo.fetch(new Request("https://example.test/api/auth/get-session"));

        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("refuses the internal session route without the secret", async () => {
        expect.assertions(2);

        const { authDo } = createDo();
        const response = await resolveSession(authDo);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toStrictEqual({ error: "unauthorized" });
    });

    it("refuses the internal session route with the wrong secret", async () => {
        expect.assertions(1);

        const { authDo } = createDo();
        const response = await resolveSession(authDo, { [INTERNAL_SECRET_HEADER]: "not-the-secret" });

        expect(response.status).toBe(401);
    });

    it("refuses the internal session route when no secret is configured, rather than serving it open", async () => {
        expect.assertions(1);

        const { authDo } = createDo({}, {});

        // A missing secret is a misconfiguration. Answering identity questions to
        // any worker bound to the namespace is the one failure mode worth being
        // loud about, so it fails closed.
        const response = await resolveSession(authDo, { [INTERNAL_SECRET_HEADER]: "anything" });

        expect(response.status).toBe(401);
    });

    it("reports an anonymous request as having no user", async () => {
        expect.assertions(2);

        const { authDo } = createDo();
        const response = await resolveSession(authDo, { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({});
    });

    it("resolves a signed-in session back to its user id", async () => {
        expect.assertions(2);

        const { authDo } = createDo({ emailAndPassword: { enabled: true } });

        const signUp = await authDo.fetch(
            new Request("https://example.test/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "ada@acme.test", name: "Ada", password: "correct-horse-battery" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(signUp.status).toBe(200);

        // Carry the session cookie the way the worker forwards a real request's
        // headers — this is exactly the path `resolveIdentity` takes in DO mode.
        const cookie = signUp.headers.get("set-cookie") ?? "";
        const resolved = await resolveSession(authDo, {
            cookie: cookie.split(";")[0] ?? "",
            [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET,
        });

        await expect(resolved.json()).resolves.toMatchObject({ userId: expect.any(String) });
    });

    it("answers with the session expiry and role, not just the user id", async () => {
        expect.assertions(3);

        const { authDo } = createDo({ emailAndPassword: { enabled: true }, plugins: [admin()] });

        const signUp = await authDo.fetch(
            new Request("https://example.test/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "grace@acme.test", name: "Grace", password: "correct-horse-battery" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
        const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const resolved = await resolveSession(authDo, { cookie, [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET });
        const body: { expiresAtMs?: number; role?: string; userId?: string } = await resolved.json();

        expect(body.userId).toEqual(expect.any(String));

        // `expiresAtMs` becomes the socket's credential expiry (`x-lunora-identity-exp`).
        // Without it the DO's expiry check is permanently false, so a signed-out,
        // banned or lapsed user keeps streaming their RLS-scoped rows over an already
        // open WebSocket while every HTTP call is anonymous.
        expect(body.expiresAtMs).toBeGreaterThan(Date.now());

        // `role` is what `readIdentityRoles` reads for RLS role grants. The D1 wiring
        // forwards it; dropping it here made `.auth({ d1 })` -> `.auth({ namespace })`
        // silently turn every role-based grant off.
        expect(body.role).toBe("user");
    });

    it("drives the real worker-side wiring end to end, expiry, role and profile claims intact", async () => {
        expect.assertions(4);

        const { authDo } = createDo({ emailAndPassword: { enabled: true }, plugins: [admin()] });

        const signUp = await authDo.fetch(
            new Request("https://example.test/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "linus@acme.test", name: "Linus", password: "correct-horse-battery" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
        const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

        // The real wiring, over the real object — no stubbed session payload. This is
        // the identity `createWorker` turns into `x-lunora-userid` /
        // `x-lunora-identity` / `x-lunora-identity-exp`.
        const { resolveIdentity } = createDoAuthWiring({
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: (request: Request) => authDo.fetch(request) };
                },
                idFromName: (name: string) => name,
            },
        });

        const identity = await resolveIdentity(new Request("https://example.test/_lunora/rpc", { headers: { cookie } }));

        expect(identity?.expiresAtMs).toBeGreaterThan(Date.now());
        expect(identity?.role).toBe("user");

        // `email` / `name` are what `ctx.auth.getIdentity()` is documented to carry
        // ("email, name, roles, custom claims"). Dropping them here made the
        // documented `me` query — `identity?.email` — resolve `undefined` on every
        // app using the built-in DO wiring.
        expect(identity?.["email"]).toBe("linus@acme.test");
        expect(identity?.["name"]).toBe("Linus");
    });

    it("serves the audit log to a trusted caller, creating its table on demand", async () => {
        expect.assertions(2);

        const { authDo } = createDo();
        const response = await authDo.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, {
                body: JSON.stringify({ limit: 5 }),
                headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);

        // The audit table is not part of `authTables`, so a 200 with an empty list is
        // the proof it was created rather than erroring on a missing table.
        await expect(response.json()).resolves.toStrictEqual({ entries: [] });
    });

    /**
     * Plan 280 §5 S3: a trusted caller sending a malformed body previously threw
     * an unhandled exception out of `#readAudit` (an opaque 500) instead of the
     * 400 a caller error deserves.
     */
    it("400s a trusted caller's malformed (non-JSON) body instead of throwing a 500", async () => {
        expect.assertions(2);

        const { authDo } = createDo();
        const response = await authDo.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, {
                body: "not-json",
                headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
    });

    /**
     * Plan 280 §5 S3: a non-numeric `limit` previously reached `readAuthAuditLog`
     * unchecked, where `Math.min`/`Math.max` propagate `NaN` and it is bound as
     * the SQL `LIMIT` parameter.
     */
    it("400s a non-numeric `limit` instead of letting NaN reach the SQL LIMIT clause", async () => {
        expect.assertions(1);

        const { authDo } = createDo();
        const response = await authDo.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, {
                body: JSON.stringify({ limit: "1e2junk" }),
                headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
    });

    it("400s an unknown audit-read option instead of silently ignoring it", async () => {
        expect.assertions(1);

        const { authDo } = createDo();
        const response = await authDo.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, {
                body: JSON.stringify({ limit: 5, unexpectedField: "anything" }),
                headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
    });

    it("refuses the audit log without the secret", async () => {
        expect.assertions(1);

        const { authDo } = createDo();
        const response = await authDo.fetch(
            new Request(`https://example.test${READ_AUDIT_PATH}`, {
                body: JSON.stringify({}),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        // The log is forensic data about real users; the same boundary as the session route.
        expect(response.status).toBe(401);
    });

    it("404s a path that is neither an auth route nor the internal one", async () => {
        expect.assertions(1);

        const { authDo } = createDo();
        const response = await authDo.fetch(new Request("https://example.test/not-auth"));

        expect(response.status).toBe(404);
    });
});
