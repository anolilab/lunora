import { DatabaseSync } from "node:sqlite";

import { organization } from "better-auth/plugins/organization";
import { describe, expect, it } from "vitest";

import { LunoraAuthDO } from "../src/auth-do";
import { createDoAuthWiring } from "../src/do-wiring";
import { identityFromSession } from "../src/session-identity";
import CookieJar from "./helpers/cookie-jar";
import createDoStorage from "./helpers/do-storage";
import createMemoryAuth from "./helpers/memory-auth";

/**
 * The organization claims on the built-in identity. Both wirings — the D1 resolver
 * codegen emits (`identityFromSession` over `auth.api.getSession`) and the DO's
 * internal session route behind `createDoAuthWiring` — must show the organization and
 * team an endpoint just made active on the very next request, read through a cookie
 * jar the way a browser presents the session.
 */

const SECRET = "x".repeat(32);
const INTERNAL_SECRET = "session-identity-internal-secret"; // secret-scanner:allow
const PASSWORD = "correct horse battery staple";

const authOptions = {
    baseURL: "https://example.test",
    emailAndPassword: { enabled: true },
    plugins: [organization({ teams: { enabled: true } })],
    rateLimit: { enabled: false },
    secret: SECRET,
};

describe("identityFromSession", () => {
    it("is anonymous without a signed-in user", () => {
        expect.assertions(2);

        expect(identityFromSession(null)).toBeNull();
        expect(identityFromSession({ session: {}, user: { id: "" } })).toBeNull();
    });

    it("forwards the expiry, profile and role claims", () => {
        expect.assertions(1);

        const expiresAt = new Date(Date.now() + 3_600_000);

        // `expiresAtMs` becomes `x-lunora-identity-exp` (an open socket closes once it
        // lapses), `role` feeds RLS role grants, `email`/`name` the documented `me` query.
        expect(identityFromSession({ session: { expiresAt }, user: { email: "ada@acme.test", id: "u1", name: "Ada", role: "admin,editor" } })).toStrictEqual({
            email: "ada@acme.test",
            expiresAtMs: expiresAt.getTime(),
            name: "Ada",
            role: "admin,editor",
            userId: "u1",
        });
    });

    it("drops absent, null and empty claims rather than forwarding them", () => {
        expect.assertions(1);

        expect(
            identityFromSession({
                session: { activeOrganizationId: null, activeTeamId: "", expiresAt: "not a date" },
                user: { email: "", id: "u1", name: undefined, role: null },
            }),
        ).toStrictEqual({ userId: "u1" });
    });

    describe("on the D1 wiring", () => {
        it("carries the organization and team the caller just made active", async () => {
            expect.assertions(4);

            // The endpoint map is generic over the resolved plugin set; `any` skips re-deriving it.
            const auth: any = createMemoryAuth(authOptions);
            const jar = new CookieJar();
            const identity = async (): Promise<ReturnType<typeof identityFromSession>> =>
                identityFromSession(await auth.api.getSession({ headers: jar.headers() }));
            const call = async (endpoint: string, body: Record<string, unknown>): Promise<any> => {
                const result = await auth.api[endpoint]({ body, headers: jar.headers(), returnHeaders: true });

                jar.absorb(result.headers);

                return result.response;
            };

            const { user } = await call("signUpEmail", { email: "ada@example.com", name: "Ada", password: PASSWORD });

            await expect(identity()).resolves.not.toHaveProperty("orgId");

            const acme = await call("createOrganization", { name: "Acme", slug: "acme" });

            await expect(identity()).resolves.toMatchObject({ email: "ada@example.com", orgId: acme.id });

            const globex = await call("createOrganization", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

            await call("setActiveOrganization", { organizationId: globex.id });

            await expect(identity()).resolves.toMatchObject({ orgId: globex.id });

            const team = await call("createTeam", { name: "core", organizationId: globex.id });

            await call("addTeamMember", { teamId: team.id, userId: user.id });
            await call("setActiveTeam", { teamId: team.id });

            await expect(identity()).resolves.toMatchObject({ orgId: globex.id, teamId: team.id });
        });
    });

    describe("on the Durable Object wiring", () => {
        it("carries the organization and team the caller just made active", async () => {
            expect.assertions(3);

            const authDo = new LunoraAuthDO({ storage: createDoStorage(new DatabaseSync(":memory:")) }, () => authOptions, {
                internalSecret: INTERNAL_SECRET,
            });
            const { resolveIdentity } = createDoAuthWiring({
                internalSecret: INTERNAL_SECRET,
                namespace: {
                    get: () => {
                        return { fetch: (request: Request) => authDo.fetch(request) };
                    },
                    idFromName: (name: string) => name,
                },
            });
            const jar = new CookieJar();
            const post = async (path: string, body: Record<string, unknown>): Promise<any> => {
                const headers = jar.headers();

                headers.set("content-type", "application/json");
                headers.set("origin", "https://example.test");

                const response = await authDo.fetch(
                    new Request(`https://example.test/api/auth${path}`, { body: JSON.stringify(body), headers, method: "POST" }),
                );

                if (!response.ok) {
                    throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`);
                }

                jar.absorb(response.headers);

                return response.json();
            };
            const identity = async (): Promise<Awaited<ReturnType<typeof resolveIdentity>>> =>
                resolveIdentity(new Request("https://example.test/_lunora/rpc", { headers: jar.headers() }));

            const { user } = await post("/sign-up/email", { email: "grace@example.com", name: "Grace", password: PASSWORD });

            const acme = await post("/organization/create", { name: "Acme", slug: "acme" });

            await expect(identity()).resolves.toMatchObject({ orgId: acme.id });

            const globex = await post("/organization/create", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

            await post("/organization/set-active", { organizationId: globex.id });

            await expect(identity()).resolves.toMatchObject({ orgId: globex.id });

            const team = await post("/organization/create-team", { name: "core", organizationId: globex.id });

            await post("/organization/add-team-member", { teamId: team.id, userId: user.id });
            await post("/organization/set-active-team", { teamId: team.id });

            await expect(identity()).resolves.toMatchObject({ orgId: globex.id, teamId: team.id });
        });
    });
});
