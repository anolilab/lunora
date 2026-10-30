import { DatabaseSync } from "node:sqlite";

import { organization } from "better-auth/plugins/organization";
import { describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { LunoraAuthDO } from "../src/auth-do";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createDoAuthWiring } from "../src/do-wiring";
import type { SessionIdentity } from "../src/session-identity";
import { identityFromSession, resolveSessionIdentity } from "../src/session-identity";
import CookieJar from "./helpers/cookie-jar";
import createDoStorage from "./helpers/do-storage";
import createMemoryAuth from "./helpers/memory-auth";

/**
 * The organization claims on the built-in identity. Both wirings — the D1 resolver
 * codegen emits and the DO's internal session route behind `createDoAuthWiring` —
 * call `resolveSessionIdentity`. They must show the organization and team an endpoint
 * just made active on the very next request, and must stop showing them once the
 * membership behind them is gone, however it went: better-auth leaves the session's
 * `activeOrganizationId` / `activeTeamId` in place for everyone but the caller.
 */

const SECRET = "x".repeat(32);
const INTERNAL_SECRET = "session-identity-internal-secret"; // secret-scanner:allow
const PASSWORD = "correct horse battery staple";

const authOptions = (cookieCache = true): LunoraAuthOptions => {
    return {
        baseURL: "https://example.test",
        emailAndPassword: { enabled: true },
        plugins: [organization({ teams: { enabled: true } })],
        rateLimit: { enabled: false },
        secret: SECRET,
        ...(cookieCache ? {} : { session: { cookieCache: { enabled: false } } }),
    };
};

/** A signed-in browser: its cookie jar and its user id. */
interface Browser {
    jar: CookieJar;
    userId: string;
}

/** Drive the real endpoints in process, the way the D1 wiring's auth instance runs. */
const memoryHarness = (cookieCache = true) => {
    // The endpoint map is generic over the resolved plugin set; `any` skips re-deriving it.
    const auth: any = createMemoryAuth(authOptions(cookieCache));

    const call = async (browser: Browser | undefined, endpoint: string, body: Record<string, unknown>): Promise<any> => {
        const result = await auth.api[endpoint]({ body, ...(browser ? { headers: browser.jar.headers() } : {}), returnHeaders: true });

        browser?.jar.absorb(result.headers);

        return result.response;
    };

    const signUp = async (email: string): Promise<Browser> => {
        const jar = new CookieJar();
        const browser = { jar, userId: "" };
        const { user } = await call(browser, "signUpEmail", { email, name: email, password: PASSWORD });

        browser.userId = user.id;

        return browser;
    };

    const identity = async (browser: Browser): Promise<SessionIdentity | null> => resolveSessionIdentity(auth, browser.jar.headers());

    /** An owner with organization Acme, and a second user who joined it and made it active. */
    const ownerAndMember = async (): Promise<{ acme: { id: string }; member: Browser; memberId: string; owner: Browser }> => {
        const owner = await signUp("owner@example.com");
        const acme = await call(owner, "createOrganization", { name: "Acme", slug: "acme" });
        const member = await signUp("grace@example.com");
        const row = await call(undefined, "addMember", { organizationId: acme.id, role: "member", userId: member.userId });

        await call(member, "setActiveOrganization", { organizationId: acme.id });

        return { acme, member, memberId: row.id, owner };
    };

    return { auth, call, identity, ownerAndMember, signUp };
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
});

describe("resolveSessionIdentity", () => {
    it("carries the organization and team the caller just made active", async () => {
        expect.assertions(4);

        const { call, identity, signUp } = memoryHarness();
        const ada = await signUp("ada@example.com");

        await expect(identity(ada)).resolves.not.toHaveProperty("orgId");

        const acme = await call(ada, "createOrganization", { name: "Acme", slug: "acme" });

        await expect(identity(ada)).resolves.toMatchObject({ email: "ada@example.com", orgId: acme.id });

        const globex = await call(ada, "createOrganization", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

        await call(ada, "setActiveOrganization", { organizationId: globex.id });

        await expect(identity(ada)).resolves.toMatchObject({ orgId: globex.id });

        const team = await call(ada, "createTeam", { name: "core", organizationId: globex.id });

        await call(ada, "addTeamMember", { teamId: team.id, userId: ada.userId });
        await call(ada, "setActiveTeam", { teamId: team.id });

        await expect(identity(ada)).resolves.toMatchObject({ orgId: globex.id, teamId: team.id });
    });

    it("drops the organization of a member an admin removed, though the cached session still names it", async () => {
        expect.assertions(3);

        const { auth, call, identity, ownerAndMember } = memoryHarness();
        const { acme, member, owner } = await ownerAndMember();

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id });

        await call(owner, "removeMember", { memberIdOrEmail: "grace@example.com", organizationId: acme.id });

        // better-auth cannot refresh another user's cookie, so the session the request
        // carries still names the organization; the claim must not follow it.
        const session = await auth.api.getSession({ headers: member.jar.headers() });

        expect(session?.session.activeOrganizationId).toBe(acme.id);
        await expect(identity(member)).resolves.not.toHaveProperty("orgId");
    });

    it("drops the organization of a removed member with the cookie cache off, where the stored session still names it", async () => {
        expect.assertions(2);

        const { call, identity, ownerAndMember } = memoryHarness(false);
        const { acme, member, owner } = await ownerAndMember();

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id });

        await call(owner, "removeMember", { memberIdOrEmail: "grace@example.com", organizationId: acme.id });

        await expect(identity(member)).resolves.not.toHaveProperty("orgId");
    });

    it("drops the organization once it is deleted", async () => {
        expect.assertions(2);

        const { call, identity, ownerAndMember } = memoryHarness(false);
        const { acme, member, owner } = await ownerAndMember();

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id });

        await call(owner, "deleteOrganization", { organizationId: acme.id });

        await expect(identity(member)).resolves.not.toHaveProperty("orgId");
    });

    it("drops the organization of a member removed through createAuthAdmin, which no endpoint hook sees", async () => {
        expect.assertions(2);

        const { auth, identity, ownerAndMember } = memoryHarness(false);
        const { acme, member, memberId } = await ownerAndMember();

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id });

        await createAuthAdmin(auth).removeMember({ memberId });

        await expect(identity(member)).resolves.not.toHaveProperty("orgId");
    });

    it("drops the team once the caller switches organization, which better-auth leaves on the session", async () => {
        expect.assertions(2);

        const { call, identity, signUp } = memoryHarness();
        const ada = await signUp("ada@example.com");
        const acme = await call(ada, "createOrganization", { name: "Acme", slug: "acme" });
        const team = await call(ada, "createTeam", { name: "core", organizationId: acme.id });

        await call(ada, "addTeamMember", { teamId: team.id, userId: ada.userId });
        await call(ada, "setActiveTeam", { teamId: team.id });

        const globex = await call(ada, "createOrganization", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

        await call(ada, "setActiveOrganization", { organizationId: globex.id });

        const resolved = await identity(ada);

        expect(resolved).toMatchObject({ orgId: globex.id });
        expect(resolved).not.toHaveProperty("teamId");
    });

    it("drops the team of a member taken off it, keeping the organization", async () => {
        expect.assertions(3);

        const { call, identity, ownerAndMember } = memoryHarness(false);
        const { acme, member, owner } = await ownerAndMember();
        const team = await call(owner, "createTeam", { name: "core", organizationId: acme.id });

        await call(owner, "addTeamMember", { teamId: team.id, userId: member.userId });
        await call(member, "setActiveTeam", { teamId: team.id });

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id, teamId: team.id });

        await call(owner, "removeTeamMember", { teamId: team.id, userId: member.userId });

        const resolved = await identity(member);

        expect(resolved).toMatchObject({ orgId: acme.id });
        // Asserted apart from the match above so a regression names the claim.
        expect(resolved).not.toHaveProperty("teamId");
    });
});

describe("the Durable Object wiring", () => {
    const harness = () => {
        const authDo = new LunoraAuthDO({ storage: createDoStorage(new DatabaseSync(":memory:")) }, () => authOptions(), {
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
        const post = async (jar: CookieJar, path: string, body: Record<string, unknown>): Promise<any> => {
            const headers = jar.headers();

            headers.set("content-type", "application/json");
            headers.set("origin", "https://example.test");

            const response = await authDo.fetch(new Request(`https://example.test/api/auth${path}`, { body: JSON.stringify(body), headers, method: "POST" }));

            if (!response.ok) {
                throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`);
            }

            jar.absorb(response.headers);

            return response.json();
        };
        const identity = async (jar: CookieJar): Promise<SessionIdentity | null> =>
            resolveIdentity(new Request("https://example.test/_lunora/rpc", { headers: jar.headers() }));

        return { identity, post };
    };

    it("carries the organization and team the caller just made active", async () => {
        expect.assertions(3);

        const { identity, post } = harness();
        const jar = new CookieJar();
        const { user } = await post(jar, "/sign-up/email", { email: "grace@example.com", name: "Grace", password: PASSWORD });
        const acme = await post(jar, "/organization/create", { name: "Acme", slug: "acme" });

        await expect(identity(jar)).resolves.toMatchObject({ orgId: acme.id });

        const globex = await post(jar, "/organization/create", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

        await post(jar, "/organization/set-active", { organizationId: globex.id });

        await expect(identity(jar)).resolves.toMatchObject({ orgId: globex.id });

        const team = await post(jar, "/organization/create-team", { name: "core", organizationId: globex.id });

        await post(jar, "/organization/add-team-member", { teamId: team.id, userId: user.id });
        await post(jar, "/organization/set-active-team", { teamId: team.id });

        await expect(identity(jar)).resolves.toMatchObject({ orgId: globex.id, teamId: team.id });
    });

    it("drops the organization of a member an admin removed", async () => {
        expect.assertions(2);

        const { identity, post } = harness();
        const owner = new CookieJar();
        const member = new CookieJar();

        await post(owner, "/sign-up/email", { email: "owner@example.com", name: "Owner", password: PASSWORD });
        await post(member, "/sign-up/email", { email: "grace@example.com", name: "Grace", password: PASSWORD });

        const acme = await post(owner, "/organization/create", { name: "Acme", slug: "acme" });
        const invitation = await post(owner, "/organization/invite-member", { email: "grace@example.com", organizationId: acme.id, role: "member" });

        await post(member, "/organization/accept-invitation", { invitationId: invitation.id });

        await expect(identity(member)).resolves.toMatchObject({ orgId: acme.id });

        await post(owner, "/organization/remove-member", { memberIdOrEmail: "grace@example.com", organizationId: acme.id });

        await expect(identity(member)).resolves.not.toHaveProperty("orgId");
    });
});
