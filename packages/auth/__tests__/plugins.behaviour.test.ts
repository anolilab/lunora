import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, test } from "vitest";

import { createAuth } from "../src/create-auth.js";
import { admin, organization } from "../src/plugins.js";

/**
 * Round-trip behaviour for the two highest-value better-auth plugins Cirrus
 * wraps — `admin` (ban/impersonate) and `organization` (orgs/teams). The
 * tests exercise the real better-auth runtime against an in-memory adapter:
 * no mocks, no stubs.
 *
 * We never get to the workerd-backed D1 path here because the migration
 * runner only supports the kysely adapter. That's fine — the migration code
 * itself is covered elsewhere, and these tests are about confirming the
 * plugin endpoints we re-export from `@cirrus/auth/plugins` do the right
 * thing end-to-end when wired against an auth instance.
 */

const SECRET = "x".repeat(32);

const STRONG_PASSWORD = "correct horse battery staple";

const seedMemoryDb = (): Record<string, unknown[]> => ({
    account: [],
    invitation: [],
    member: [],
    organization: [],
    session: [],
    team: [],
    user: [],
    verification: [],
});

/**
 * Sign in as `email`/`password` and pull the `cookie` header from the
 * response so subsequent endpoint calls can be made "as that user".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const signInAndCookie = async (auth: any, email: string, password: string): Promise<Headers> => {
    const response = await auth.api.signInEmail({
        body: { email, password },
        returnHeaders: true,
    });

    const setCookie = response.headers.get("set-cookie");

    if (!setCookie) {
        throw new Error("sign-in did not return a set-cookie header");
    }

    const headers = new Headers();

    headers.set("cookie", setCookie);

    return headers;
};

describe("admin plugin behaviour", () => {
    let memoryDb: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints are reachable through `auth.api` without re-deriving the full
    // generic chain here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let auth: any;
    let adminId: string;
    let adminHeaders: Headers;

    beforeEach(async () => {
        memoryDb = seedMemoryDb();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDb),
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

        const userRow = memoryDb["user"]?.find((row) => (row as { id: string }).id === adminId) as Record<string, unknown>;

        userRow["role"] = "admin";

        adminHeaders = await signInAndCookie(auth, "root@example.com", STRONG_PASSWORD);
    });

    test("banUser flips the user row's banned flag", async () => {
        expect.assertions(2);

        // Sign up a regular user that the admin will then ban.
        const signUp = await auth.api.signUpEmail({
            body: { email: "user@example.com", name: "Regular User", password: STRONG_PASSWORD },
        });
        const userId = signUp.user.id;

        await auth.api.banUser({
            body: { banReason: "spam", userId },
            headers: adminHeaders,
        });

        const userRow = memoryDb["user"]?.find((row) => (row as { id: string }).id === userId) as { banReason?: string; banned?: boolean } | undefined;

        expect(userRow?.banned).toBe(true);
        expect(userRow?.banReason).toBe("spam");
    });

    test("a banned user cannot sign in", async () => {
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
    let memoryDb: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints are reachable through `auth.api` without re-deriving the full
    // generic chain here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let auth: any;

    beforeEach(() => {
        memoryDb = seedMemoryDb();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDb),
            emailAndPassword: { enabled: true },
            plugins: [organization()],
            secret: SECRET,
        });
    });

    test("createOrganization persists a row and seeds the owner membership", async () => {
        expect.assertions(3);

        const signUp = await auth.api.signUpEmail({
            body: { email: "founder@example.com", name: "Founder", password: STRONG_PASSWORD },
        });
        const ownerId = signUp.user.id;

        const org = (await auth.api.createOrganization({
            body: { name: "Acme", slug: "acme", userId: ownerId },
        })) as { id: string } | null;

        expect(org).not.toBeNull();

        const organizations = (memoryDb["organization"] ?? []) as Array<{ name: string; slug: string }>;

        expect(organizations).toEqual([expect.objectContaining({ name: "Acme", slug: "acme" })]);

        // The plugin auto-creates a `member` row for the creator with the
        // `owner` role. That's the contract third-party admin UIs rely on,
        // so we lock it in here.
        const members = (memoryDb["member"] ?? []) as Array<{ organizationId: string; role: string; userId: string }>;

        expect(members).toEqual([expect.objectContaining({ organizationId: org?.id, role: "owner", userId: ownerId })]);
    });

    test("createInvitation stores an invitation row tied to the org", async () => {
        expect.assertions(2);

        // Bootstrap an owner + organization the same way the previous test does.
        await auth.api.signUpEmail({
            body: { email: "lead@example.com", name: "Lead", password: STRONG_PASSWORD },
        });
        const ownerHeaders = await signInAndCookie(auth, "lead@example.com", STRONG_PASSWORD);
        const ownerId = (memoryDb["user"]?.find((row) => (row as { email: string }).email === "lead@example.com") as { id: string }).id;

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

        const invitations = (memoryDb["invitation"] ?? []) as Array<{
            email: string;
            inviterId: string;
            organizationId: string;
            role: string;
        }>;

        expect(invitations).toHaveLength(1);
        expect(invitations[0]).toMatchObject({
            email: "invitee@example.com",
            inviterId: ownerId,
            organizationId: org.id,
            role: "member",
        });
    });
});
