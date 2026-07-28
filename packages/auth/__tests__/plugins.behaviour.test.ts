import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "../src/create-auth";
import { admin, organization } from "../src/plugins";
import signInAndCookie from "./_helpers/auth-session";

/**
 * Round-trip behaviour for the two highest-value better-auth plugins Lunora
 * wraps — `admin` (ban/impersonate) and `organization` (orgs/teams). The
 * tests exercise the real better-auth runtime against an in-memory adapter:
 * no mocks, no stubs.
 *
 * We never get to the workerd-backed D1 path here because the migration
 * runner only supports the kysely adapter. That's fine — the migration code
 * itself is covered elsewhere, and these tests are about confirming the
 * plugin endpoints we re-export from `@lunora/auth/plugins` do the right
 * thing end-to-end when wired against an auth instance.
 */

const SECRET = "x".repeat(32);

const STRONG_PASSWORD = "correct horse battery staple";

const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return {
        account: [],
        invitation: [],
        member: [],
        organization: [],
        session: [],
        team: [],
        user: [],
        verification: [],
    };
};

describe("admin plugin behaviour", () => {
    let memoryDatabase: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints are reachable through `auth.api` without re-deriving the full
    // generic chain here.
    let auth: any;
    let adminId: string;
    let adminHeaders: Headers;

    beforeEach(async () => {
        memoryDatabase = seedMemoryDatabase();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin()],
            secret: SECRET,
        });

        // Provision an admin account first so subsequent endpoint calls have
        // a session cookie. The admin plugin grants the `admin` role to any
        // user listed in `adminUserIds`; we patch the row after sign-up so we
        // don't have to know the id ahead of time.
        const adminSignUp = await auth.api.signUpEmail({
            body: { email: "root@example.com", name: "Root", password: STRONG_PASSWORD },
        });

        adminId = adminSignUp.user.id;

        const userRow = memoryDatabase["user"]?.find((row) => (row as { id: string }).id === adminId) as Record<string, unknown>;

        userRow["role"] = "admin";

        adminHeaders = await signInAndCookie(auth, "root@example.com", STRONG_PASSWORD);
    });

    it("banUser flips the user row's banned flag", async () => {
        expect.assertions(2);

        // Sign up a regular user that the admin will then ban.
        const signUp = await auth.api.signUpEmail({
            body: { email: "user@example.com", name: "Regular User", password: STRONG_PASSWORD }, // gitleaks:allow -- test fixture password, not a real secret
        });
        const userId = signUp.user.id;

        await auth.api.banUser({
            body: { banReason: "spam", userId },
            headers: adminHeaders,
        });

        const userRow = memoryDatabase["user"]?.find((row) => (row as { id: string }).id === userId) as { banned?: boolean; banReason?: string } | undefined;

        expect(userRow?.banned).toBe(true);
        expect(userRow?.banReason).toBe("spam");
    });

    it("a banned user cannot sign in", async () => {
        expect.assertions(2);

        const signUp = await auth.api.signUpEmail({
            body: { email: "victim@example.com", name: "Victim", password: STRONG_PASSWORD },
        });

        // Sanity: pre-ban sign-in works.
        await expect(
            auth.api.signInEmail({
                body: { email: "victim@example.com", password: STRONG_PASSWORD },
            }),
        ).resolves.toBeDefined();

        await auth.api.banUser({
            body: { userId: signUp.user.id },
            headers: adminHeaders,
        });

        // Better-auth throws an `APIError` from the sign-in endpoint when the
        // account is banned. We don't need the exact error shape — proving
        // sign-in *rejects* is enough.
        await expect(
            auth.api.signInEmail({
                body: { email: "victim@example.com", password: STRONG_PASSWORD },
            }),
        ).rejects.toBeDefined();
    });
});

describe("organization plugin behaviour", () => {
    let memoryDatabase: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints are reachable through `auth.api` without re-deriving the full
    // generic chain here.
    let auth: any;

    beforeEach(() => {
        memoryDatabase = seedMemoryDatabase();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDatabase),
            emailAndPassword: { enabled: true },
            plugins: [organization()],
            secret: SECRET,
        });
    });

    it("createOrganization persists a row and seeds the owner membership", async () => {
        expect.assertions(3);

        const signUp = await auth.api.signUpEmail({
            body: { email: "founder@example.com", name: "Founder", password: STRONG_PASSWORD },
        });
        const ownerId = signUp.user.id;

        const org = (await auth.api.createOrganization({
            body: { name: "Acme", slug: "acme", userId: ownerId },
        })) as { id: string } | null;

        expect(org).not.toBeNull();

        const organizations = (memoryDatabase["organization"] ?? []) as { name: string; slug: string }[];

        expect(organizations).toEqual([expect.objectContaining({ name: "Acme", slug: "acme" })]);

        // The plugin auto-creates a `member` row for the creator with the
        // `owner` role. That's the contract third-party admin UIs rely on,
        // so we lock it in here.
        const members = (memoryDatabase["member"] ?? []) as { organizationId: string; role: string; userId: string }[];

        expect(members).toEqual([expect.objectContaining({ organizationId: org?.id, role: "owner", userId: ownerId })]);
    });

    it("createInvitation stores an invitation row tied to the org", async () => {
        expect.assertions(2);

        // Bootstrap an owner + organization the same way the previous test does.
        await auth.api.signUpEmail({
            body: { email: "lead@example.com", name: "Lead", password: STRONG_PASSWORD },
        });
        const ownerHeaders = await signInAndCookie(auth, "lead@example.com", STRONG_PASSWORD);
        const ownerId = (memoryDatabase["user"]?.find((row) => (row as { email: string }).email === "lead@example.com") as { id: string }).id;

        const org = (await auth.api.createOrganization({
            body: { name: "Initech", slug: "initech" },
            headers: ownerHeaders,
        })) as { id: string };

        // The invitation endpoint resolves the active org from the caller's
        // session. We pass `organizationId` to make the test resilient to
        // future changes in the session-vs-body precedence.
        await auth.api.createInvitation({
            body: {
                email: "invitee@example.com",
                organizationId: org.id,
                role: "member",
            },
            headers: ownerHeaders,
        });

        const invitations = (memoryDatabase["invitation"] ?? []) as {
            email: string;
            inviterId: string;
            organizationId: string;
            role: string;
        }[];

        expect(invitations).toHaveLength(1);
        expect(invitations[0]).toMatchObject({
            email: "invitee@example.com",
            inviterId: ownerId,
            organizationId: org.id,
            role: "member",
        });
    });
});
