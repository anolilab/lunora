import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { LunoraAuth } from "../src/create-auth";
import { createAuth } from "../src/create-auth";
import { createSqlAuthStore } from "../src/sql-store";
import { executorFor, materialiseAuthSchema } from "./helpers/sqlite-auth-db";

/**
 * Integration coverage (audit finding #9). The other suites in this package
 * either exercise the SQL store in isolation or run better-auth over a no-op /
 * memory fake — neither catches the cross-session, time-sensitive behaviour
 * that actually protects users. These tests wire a **real** better-auth
 * instance onto a **real** in-memory SQLite database (`node:sqlite`'s
 * `DatabaseSync`, the same engine the sql-store suite uses) through Lunora's
 * `lunoraAuthAdapter` + `createSqlAuthStore`, then drive whole flows:
 *
 * (a) two concurrent logins for the same user produce two independent sessions,
 * (b) a session revoked in one place is rejected on its next use elsewhere,
 * (c) refresh under clock skew rotates the session expiry correctly.
 *
 * Because the store persists to SQLite, "use the session elsewhere" is a fresh
 * `getSession` read that goes back to the row — exactly the propagation path a
 * no-op fake can't model.
 */

const SECRET = "lunora-integration-secret-lunora-integration-xx";
const EMAIL = "ada@example.com";
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow

let database: DatabaseSync;

/**
 * A signed-in session: the unsigned token (the value stored in the `session`
 * row, used for direct DB assertions) plus the `Cookie` header better-auth
 * reads to resolve it. The cookie value is HMAC-**signed** — the raw token
 * alone won't authenticate — so we capture better-auth's own `Set-Cookie` from
 * the sign-in response and replay it verbatim.
 */
interface SignedInSession {
    cookie: Headers;
    token: string;
}

/**
 * Sign in and capture both the unsigned session token and the signed cookie
 * header. `returnHeaders: true` makes better-auth hand back the `Set-Cookie` it
 * would set on a real response; we strip it down to the `name=value` pair a
 * subsequent request would echo in its `Cookie` header.
 */
const signIn = async (auth: LunoraAuth): Promise<SignedInSession> => {
    const { headers, response } = (await auth.api.signInEmail({
        body: { email: EMAIL, password: PASSWORD },
        returnHeaders: true,
    })) as { headers: Headers; response: { token: string } };

    const setCookie = headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0] ?? "";

    return { cookie: new Headers({ cookie: cookiePair }), token: response.token };
};

describe("auth integration — real better-auth over in-memory SQLite", () => {
    const baseOptions = {
        baseURL: "http://localhost:3000",
        emailAndPassword: { enabled: true },
        secret: SECRET,
    } as const;

    const buildAuth = (sessionPolicy?: NonNullable<Parameters<typeof createAuth>[0]>["session"]): LunoraAuth =>
        createAuth({
            ...baseOptions,
            database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))),
            // Disable the signed-cookie cache so each getSession round-trips to
            // the SQLite row — that's what makes revocation observable.
            session: { cookieCache: { enabled: false }, ...sessionPolicy },
        });

    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        materialiseAuthSchema(database, baseOptions);
    });

    afterEach(() => {
        vi.useRealTimers();
        database.close();
    });

    it("(a) two concurrent logins for the same user yield two independent live sessions", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: PASSWORD } });

        // Two logins fired together — the same path a user hitting "sign in" on
        // two devices at once exercises. Both must succeed with distinct tokens.
        const [first, second] = await Promise.all([signIn(auth), signIn(auth)]);

        expect(first.token).toEqual(expect.any(String));
        expect(second.token).toEqual(expect.any(String));
        expect(first.token).not.toBe(second.token);

        // Both sessions resolve independently against the persisted rows.
        const sessionOne = await auth.api.getSession({ headers: first.cookie });
        const sessionTwo = await auth.api.getSession({ headers: second.cookie });

        expect(sessionOne?.user.email).toBe(EMAIL);
        expect(sessionTwo?.user.email).toBe(EMAIL);

        // Both sign-in tokens are persisted as distinct session rows, both for
        // the same user. (Sign-up also opens a session, so we assert on the two
        // tokens we care about rather than the exact total.)
        const rows = database.prepare(`SELECT "token", "userId" FROM "session"`).all() as { token: string; userId: string }[];
        const tokens = new Set(rows.map((row) => row.token));

        expect(tokens.has(first.token)).toBe(true);
        expect(tokens.has(second.token)).toBe(true);
        // Every session row belongs to the one signed-up user.
        expect(new Set(rows.map((row) => row.userId)).size).toBe(1);
    });

    it("(b) a session revoked in one place is rejected on its next use elsewhere", async () => {
        expect.hasAssertions();

        const auth = buildAuth();
        await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: PASSWORD } });

        // Two live sessions for the same user (two devices).
        const deviceA = await signIn(auth);
        const deviceB = await signIn(auth);

        // Both are initially valid.
        await expect(auth.api.getSession({ headers: deviceA.cookie })).resolves.not.toBeNull();
        await expect(auth.api.getSession({ headers: deviceB.cookie })).resolves.not.toBeNull();

        // Revoke device A from device A's own session (sign out one device).
        await auth.api.signOut({ headers: deviceA.cookie });

        // The revoked session is rejected on its NEXT use — this is the
        // propagation a no-op fake can't catch: the row is gone, so the fresh
        // read returns null.
        await expect(auth.api.getSession({ headers: deviceA.cookie })).resolves.toBeNull();

        // Device B is untouched — revocation is scoped to the one session.
        await expect(auth.api.getSession({ headers: deviceB.cookie })).resolves.not.toBeNull();

        // And the store agrees: device A's row is gone, device B's survives.
        const surviving = (database.prepare(`SELECT "token" FROM "session"`).all() as { token: string }[]).map((row) => row.token);

        expect(surviving).not.toContain(deviceA.token);
        expect(surviving).toContain(deviceB.token);
    });

    it("(c) refresh under clock skew rotates the session expiry forward", async () => {
        expect.hasAssertions();

        // `updateAge: 0` rotates on every use, so each authenticated read pushes
        // the session expiry forward — that's the refresh path we want to see
        // survive a jump in the wall clock.
        const auth = buildAuth({ expiresIn: 60 * 60, updateAge: 0 });
        await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: PASSWORD } });

        const session = await signIn(auth);

        const expiryOf = (token: string): number => {
            const row = database.prepare(`SELECT "expiresAt" FROM "session" WHERE "token" = ?`).get(token) as { expiresAt: string } | undefined;

            return new Date(row?.expiresAt ?? 0).getTime();
        };

        const initialExpiry = expiryOf(session.token);

        expect(initialExpiry).toBeGreaterThan(0);

        // Advance the wall clock well past the rotation interval (clock skew /
        // a long-idle session that comes back). Fake only `Date` — not the
        // timer queue — so better-auth's internal async work still resolves
        // while `Date.now()` reports a strictly later time, the exact condition
        // a refresh under skew has to handle.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));

        // Using the session again under the skewed clock must succeed AND
        // rotate the expiry forward rather than reject the still-valid session.
        const refreshed = await auth.api.getSession({ headers: session.cookie });

        expect(refreshed?.user.email).toBe(EMAIL);

        const rotatedExpiry = expiryOf(session.token);

        // The session is still valid (well within the 1h absolute lifetime) and
        // its expiry has moved strictly forward — the refresh happened under
        // skew instead of being treated as expired.
        expect(rotatedExpiry).toBeGreaterThan(initialExpiry);
    });
});
