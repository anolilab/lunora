import { parseSetCookieHeader } from "better-auth/cookies";
import { organization } from "better-auth/plugins/organization";
import { beforeEach, describe, expect, it } from "vitest";

import createMemoryAuth from "./helpers/memory-auth";

/**
 * `createAuth` defaults the session cookie cache on, so the next request's
 * `getSession` — what every `resolveIdentity` calls — answers from the signed
 * `session_data` cookie. These specs drive the real organization endpoints and
 * then read the session back through a cookie jar, the way a browser would, and
 * expect the active organization to be the one the endpoint just set.
 */

const PASSWORD = "correct horse battery staple";

/** A browser's view of cookies: each `Set-Cookie` replaces the cookie of that name. */
class CookieJar {
    readonly #cookies = new Map<string, string>();

    public absorb(headers: Headers | undefined): void {
        const raw = headers?.get("set-cookie");

        if (!raw) {
            return;
        }

        for (const [name, { value }] of parseSetCookieHeader(raw)) {
            this.#cookies.set(name, value);
        }
    }

    public has(fragment: string): boolean {
        return [...this.#cookies.keys()].some((name) => name.includes(fragment));
    }

    public headers(): Headers {
        return new Headers({ cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") });
    }
}

describe("organization endpoints refresh the session cookie cache", () => {
    // The endpoint map is generic over the resolved plugin set; `any` skips re-deriving it.
    let auth: any;

    const signUpAndIn = async (email: string): Promise<CookieJar> => {
        await auth.api.signUpEmail({ body: { email, name: email, password: PASSWORD } });

        const jar = new CookieJar();
        const signIn = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });

        jar.absorb(signIn.headers);

        return jar;
    };

    /** The active organization the *next* request sees, served from the cache cookie. */
    const activeOrganization = async (jar: CookieJar): Promise<string | null> => {
        const session = await auth.api.getSession({ headers: jar.headers() });

        return session?.session.activeOrganizationId ?? null;
    };

    const buildAuth = (teams = false): any =>
        createMemoryAuth({
            baseURL: "http://localhost",
            emailAndPassword: { enabled: true },
            plugins: [organization(teams ? { teams: { enabled: true } } : {})],
            rateLimit: { enabled: false },
            secret: "x".repeat(32),
        });

    /** An owner with an organization, and a signed-in user invited to it (optionally into one team). */
    const invitedUser = async (teamName?: string): Promise<{ invitationId: string; invitee: CookieJar; org: { id: string }; owner: CookieJar }> => {
        const owner = await signUpAndIn("owner@example.com");
        const org = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers() });
        const team =
            teamName === undefined ? undefined : await auth.api.createTeam({ body: { name: teamName, organizationId: org.id }, headers: owner.headers() });
        const invitation = await auth.api.createInvitation({
            body: { email: "grace@example.com", organizationId: org.id, role: "member", ...(team ? { teamId: team.id } : {}) },
            headers: owner.headers(),
        });
        const invitee = await signUpAndIn("grace@example.com");

        return { invitationId: invitation.id, invitee, org, owner };
    };

    const accept = async (invitee: CookieJar, invitationId: string): Promise<void> => {
        const accepted = await auth.api.acceptInvitation({ body: { invitationId }, headers: invitee.headers(), returnHeaders: true });

        invitee.absorb(accepted.headers);
    };

    beforeEach(() => {
        auth = buildAuth();
    });

    it("shows a newly created organization as active on the next request", async () => {
        expect.assertions(3);

        const jar = await signUpAndIn("ada@example.com");

        // The jar already holds a cache cookie, so the read below is a cache hit.
        expect(jar.has("session_data")).toBe(true);
        await expect(activeOrganization(jar)).resolves.toBeNull();

        const created = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: jar.headers(), returnHeaders: true });

        jar.absorb(created.headers);

        await expect(activeOrganization(jar)).resolves.toBe(created.response.id);
    });

    it("shows the organization of an accepted invitation as active on the next request", async () => {
        expect.assertions(2);

        const { invitationId, invitee, org } = await invitedUser();

        await expect(activeOrganization(invitee)).resolves.toBeNull();

        await accept(invitee, invitationId);

        await expect(activeOrganization(invitee)).resolves.toBe(org.id);
    });

    it("overrides the stale cache cookie accept-invitation writes on its single-team path", async () => {
        expect.assertions(1);

        auth = buildAuth(true);

        const { invitationId, invitee, org } = await invitedUser("core");

        await accept(invitee, invitationId);

        await expect(activeOrganization(invitee)).resolves.toBe(org.id);
    });

    it("clears the active organization on the next request after leaving it", async () => {
        expect.assertions(2);

        const { invitationId, invitee, org } = await invitedUser();

        await accept(invitee, invitationId);

        await expect(activeOrganization(invitee)).resolves.toBe(org.id);

        const left = await auth.api.leaveOrganization({ body: { organizationId: org.id }, headers: invitee.headers(), returnHeaders: true });

        invitee.absorb(left.headers);

        await expect(activeOrganization(invitee)).resolves.toBeNull();
    });

    it("clears the active organization once a removed member's read is refused", async () => {
        expect.assertions(3);

        const { invitationId, invitee, org, owner } = await invitedUser();

        await accept(invitee, invitationId);
        await auth.api.removeMember({ body: { memberIdOrEmail: "grace@example.com", organizationId: org.id }, headers: owner.headers() });

        // Another user's cookie cannot be refreshed from the owner's response.
        await expect(activeOrganization(invitee)).resolves.toBe(org.id);

        const refused: Response = await auth.api.getFullOrganization({ asResponse: true, headers: invitee.headers() });

        invitee.absorb(refused.headers);

        expect(refused.status).toBe(403);
        await expect(activeOrganization(invitee)).resolves.toBeNull();
    });
});
