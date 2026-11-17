import { getCookieCache } from "better-auth/cookies";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AUTH_DO_SECRET_HEADER, AUTH_DO_SESSION_PATH } from "../../src/index";
import CookieJar from "../helpers/cookie-jar";
import { INTERNAL_SECRET, ORG_AUTH_ORIGIN, SECRET } from "./test-worker";

/**
 * The organization and team claims on the auth Durable Object's identity route, on
 * workerd's SQLite rather than `node:sqlite`.
 *
 * The route verifies the session's `activeOrganizationId` / `activeTeamId` against the
 * `member`, `team` and `teamMember` rows before emitting them, because better-auth
 * leaves both on every session but the caller's own. Those reads are plain adapter
 * queries over the object's storage, and the two SQLite builds disagree on enough
 * (double-quoted names, type affinity of the stored ids) that a Node pass does not
 * vouch for them here.
 *
 * Every spec drives the object's real HTTP routes with a cookie jar and gets an object
 * of its own, so emails and slugs never collide across specs.
 */

const PASSWORD = "correct horse battery staple";

interface Harness {
    /** The identity the worker's `resolveIdentity` would get for this browser. */
    identity: (jar: CookieJar) => Promise<Record<string, unknown>>;
    post: (jar: CookieJar, path: string, body: Record<string, unknown>) => Promise<{ body: any; response: Response }>;
    /** The session better-auth itself serves this browser (from the cache cookie while it is fresh). */
    session: (jar: CookieJar) => Promise<{ session: { activeOrganizationId?: string | null; activeTeamId?: string | null } }>;
    signUp: (email: string) => Promise<{ jar: CookieJar; userId: string }>;
}

const harness = (): Harness => {
    const stub = env.ORG_AUTH_DO.get(env.ORG_AUTH_DO.idFromName(crypto.randomUUID()));

    const post: Harness["post"] = async (jar, path, body) => {
        const headers = jar.headers();

        headers.set("content-type", "application/json");
        // better-auth refuses a cookie-bearing POST without a trusted origin.
        headers.set("origin", ORG_AUTH_ORIGIN);

        const response = await stub.fetch(`${ORG_AUTH_ORIGIN}/api/auth${path}`, { body: JSON.stringify(body), headers, method: "POST" });

        if (!response.ok) {
            throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`);
        }

        jar.absorb(response.headers);

        return { body: await response.json(), response };
    };

    const identity: Harness["identity"] = async (jar) => {
        const headers = jar.headers();

        headers.set(AUTH_DO_SECRET_HEADER, INTERNAL_SECRET);

        const response = await stub.fetch(`${ORG_AUTH_ORIGIN}${AUTH_DO_SESSION_PATH}`, { headers });

        if (!response.ok) {
            throw new Error(`identity answered ${String(response.status)}: ${await response.text()}`);
        }

        return response.json();
    };

    const session: Harness["session"] = async (jar) => {
        const response = await stub.fetch(`${ORG_AUTH_ORIGIN}/api/auth/get-session`, { headers: jar.headers() });

        return response.json();
    };

    const signUp: Harness["signUp"] = async (email) => {
        const jar = new CookieJar();
        const { body } = await post(jar, "/sign-up/email", { email, name: email, password: PASSWORD });

        return { jar, userId: body.user.id };
    };

    return { identity, post, session, signUp };
};

/** An owner with organization Acme, and a second user who accepted an invitation to it. */
const ownerAndMember = async ({ post, signUp }: Harness): Promise<{ acme: { id: string }; member: { jar: CookieJar; userId: string }; owner: CookieJar }> => {
    const owner = await signUp("owner@example.com");
    const member = await signUp("grace@example.com");
    const { body: acme } = await post(owner.jar, "/organization/create", { name: "Acme", slug: "acme" });
    const { body: invitation } = await post(owner.jar, "/organization/invite-member", { email: "grace@example.com", organizationId: acme.id, role: "member" });

    await post(member.jar, "/organization/accept-invitation", { invitationId: invitation.id });

    return { acme, member, owner: owner.jar };
};

describe("the auth Durable Object's organization claims in workerd", () => {
    it("re-issues the cache cookie with the organization a create made active", async () => {
        expect.assertions(3);

        const { post, signUp } = harness();
        const { jar } = await signUp("ada@example.com");
        const { body: acme, response } = await post(jar, "/organization/create", { name: "Acme", slug: "acme" });

        expect(response.headers.getSetCookie().some((cookie) => cookie.includes("session_data="))).toBe(true);

        // Decoded rather than read back through `get-session`, which could fall through
        // to the store and pass on a stale cookie. `isSecure`: the name carries the
        // `__Secure-` prefix of the https base URL, and without `NODE_ENV` the decoder
        // would look for the unprefixed one.
        const cached = await getCookieCache(jar.headers(), { isSecure: true, secret: SECRET });

        expect(cached).not.toBeNull();
        expect(cached?.session.activeOrganizationId).toBe(acme.id);
    });

    it("carries the organization and team the caller just made active", async () => {
        expect.assertions(4);

        const { identity, post, signUp } = harness();
        const ada = await signUp("ada@example.com");

        await expect(identity(ada.jar)).resolves.not.toHaveProperty("orgId");

        const { body: acme } = await post(ada.jar, "/organization/create", { name: "Acme", slug: "acme" });

        await expect(identity(ada.jar)).resolves.toMatchObject({ email: "ada@example.com", orgId: acme.id, userId: ada.userId });

        const { body: globex } = await post(ada.jar, "/organization/create", { keepCurrentActiveOrganization: true, name: "Globex", slug: "globex" });

        await post(ada.jar, "/organization/set-active", { organizationId: globex.id });

        await expect(identity(ada.jar)).resolves.toMatchObject({ orgId: globex.id });

        const { body: team } = await post(ada.jar, "/organization/create-team", { name: "core", organizationId: globex.id });

        await post(ada.jar, "/organization/add-team-member", { teamId: team.id, userId: ada.userId });
        await post(ada.jar, "/organization/set-active-team", { teamId: team.id });

        await expect(identity(ada.jar)).resolves.toMatchObject({ orgId: globex.id, teamId: team.id });
    });

    it("drops the team of a member taken off it, keeping the organization", async () => {
        expect.assertions(4);

        const h = harness();
        const { acme, member, owner } = await ownerAndMember(h);
        const { body: team } = await h.post(owner, "/organization/create-team", { name: "core", organizationId: acme.id });

        await h.post(owner, "/organization/add-team-member", { teamId: team.id, userId: member.userId });
        await h.post(member.jar, "/organization/set-active-team", { teamId: team.id });

        await expect(h.identity(member.jar)).resolves.toMatchObject({ orgId: acme.id, teamId: team.id });

        await h.post(owner, "/organization/remove-team-member", { teamId: team.id, userId: member.userId });

        // The session the member's request carries still names the team, so dropping it
        // is the identity route's doing, not better-auth's.
        await expect(h.session(member.jar)).resolves.toMatchObject({ session: { activeTeamId: team.id } });

        const resolved = await h.identity(member.jar);

        expect(resolved).toMatchObject({ orgId: acme.id });
        // Asserted apart from the match above so a regression names the claim.
        expect(resolved).not.toHaveProperty("teamId");
    });

    it("drops the organization of a member an admin removed", async () => {
        expect.assertions(3);

        const h = harness();
        const { acme, member, owner } = await ownerAndMember(h);

        await expect(h.identity(member.jar)).resolves.toMatchObject({ orgId: acme.id });

        await h.post(owner, "/organization/remove-member", { memberIdOrEmail: "grace@example.com", organizationId: acme.id });

        await expect(h.session(member.jar)).resolves.toMatchObject({ session: { activeOrganizationId: acme.id } });
        await expect(h.identity(member.jar)).resolves.not.toHaveProperty("orgId");
    });

    it("drops the organization once it is deleted", async () => {
        expect.assertions(3);

        const h = harness();
        const { acme, member, owner } = await ownerAndMember(h);

        await expect(h.identity(member.jar)).resolves.toMatchObject({ orgId: acme.id });

        await h.post(owner, "/organization/delete", { organizationId: acme.id });

        await expect(h.session(member.jar)).resolves.toMatchObject({ session: { activeOrganizationId: acme.id } });
        await expect(h.identity(member.jar)).resolves.not.toHaveProperty("orgId");
    });
});
