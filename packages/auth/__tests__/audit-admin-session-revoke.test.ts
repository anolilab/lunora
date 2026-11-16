import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppendAuthAuditEntry } from "../src/audit";
import { withAuthAudit } from "../src/audit-hooks";
import { createAuth } from "../src/create-auth";
import { admin } from "../src/plugins";
import type { SqlExecutor } from "../src/sql-store";

const SECRET = "x".repeat(32);

/** The trail itself is not under test here; `onRecord` sees each entry after it is persisted. */
const discardingExecutor: SqlExecutor = { all: () => Promise.resolve([]), run: () => Promise.resolve() };

const post = (path: string, body: unknown, cookie?: string): Request =>
    new Request(`http://localhost/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
        method: "POST",
    });

const sessionCookieOf = (response: Response): string => {
    const cookie = response.headers.getSetCookie().find((value) => /^(?:__Secure-)?better-auth\.session_token=/u.test(value));

    if (cookie === undefined) {
        throw new Error("sign-up set no session cookie");
    }

    return cookie.split(";")[0] ?? "";
};

/** Sign up an administrator and a second user, then have the administrator revoke the second user's session. */
const revokeAnotherUsersSession = async (
    hooks: { before?: (context: unknown) => Promise<unknown> } = {},
): Promise<{ adminId: unknown; recorded: AppendAuthAuditEntry[]; status: number; victim: { token: string; user: { id: string } } }> => {
    const database: Record<string, Record<string, unknown>[]> = { account: [], rateLimit: [], session: [], user: [], verification: [] };
    const recorded: AppendAuthAuditEntry[] = [];
    const auth = createAuth(
        withAuthAudit(
            { database: memoryAdapter(database), emailAndPassword: { enabled: true }, hooks, plugins: [admin()], secret: SECRET },
            {
                executor: discardingExecutor,
                onRecord: (entry) => {
                    recorded.push(entry);
                },
            },
        ),
    );
    const password = "correct horse battery staple"; // secret-scanner:allow -- test fixture password

    const adminCookie = sessionCookieOf(await auth.handler(post("/sign-up/email", { email: "admin@example.com", name: "Admin", password })));
    const adminRow = database["user"]?.find((user) => user["email"] === "admin@example.com");

    if (adminRow === undefined) {
        throw new Error("admin user was not created");
    }

    adminRow["role"] = "admin";

    await auth.handler(post("/sign-up/email", { email: "victim@example.com", name: "Victim", password }));

    const victimId = String(database["user"]?.find((user) => user["email"] === "victim@example.com")?.["id"]);
    const victimToken = String(database["session"]?.find((session) => session["userId"] === victimId)?.["token"]);
    const victim = { token: victimToken, user: { id: victimId } };
    const revoke = await auth.handler(post("/admin/revoke-user-session", { sessionToken: victim.token }, adminCookie));

    return { adminId: adminRow["id"], recorded, status: revoke.status, victim };
};

describe("admin revoke of a single session", () => {
    beforeEach(() => {
        // better-auth warns about the test secret's entropy on construction; the warning is not what this file tests.
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // `/admin/revoke-user-session` takes only a session token and answers `{ success: true }`, so after the
    // session is deleted nothing in the request or the response names whose session it was.
    it("names the user whose session was revoked, and never the token", async () => {
        expect.assertions(4);

        const { adminId, recorded, status, victim } = await revokeAnotherUsersSession();
        const entry = recorded.find((candidate) => candidate.event === "admin-session-revoke");

        expect(status).toBe(200);
        expect(entry?.detail).toMatchObject({ targetUserId: victim.user.id });
        expect(entry?.actorId).toBe(adminId);
        expect(JSON.stringify(entry)).not.toContain(victim.token);
    });

    it("keeps the caller's own before hook running alongside the capture", async () => {
        expect.assertions(2);

        const paths: unknown[] = [];
        const { recorded, victim } = await revokeAnotherUsersSession({
            before: async (context) => {
                paths.push((context as { path?: string }).path);

                return undefined;
            },
        });

        expect(paths).toContain("/admin/revoke-user-session");
        expect(recorded.find((candidate) => candidate.event === "admin-session-revoke")?.detail).toMatchObject({ targetUserId: victim.user.id });
    });
});
