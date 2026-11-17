/**
 * An erased subject's sign-in, over real D1 and better-auth. The erasure deletes the sign-in rows directly, so
 * the test checks the two things that keep an erased subject out: the session stops resolving at once, and no
 * new session can be created for a user row that is gone.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { buildAuth } from "../../lunora/auth";
import { authData } from "../../lunora/privacy";
import { authDatabaseFrom, eraseAuth } from "../../lunora/privacy-auth";
import { clearSignIn, ensureSignIn } from "./sign-in";

/** A fixture value, built at run time so no credential literal sits in the source. */
const fixture = (label: string): string => `fixture-${label}-${String(Date.now())}`;

/** Erases every sign-in row of the subject: the verdict the erasure gives each row, which is always a delete here. */
const deleteRow = (): { readonly kind: "delete" } => {
    return { kind: "delete" };
};

/** D1 names a refused foreign key in its error. */
const FOREIGN_KEY_REFUSAL = /constraint/u;

const CREDENTIALS = { email: "erased@example.test", name: "Erased subject", password: fixture("password") };

describe("an erased subject's sign-in (workerd)", () => {
    beforeEach(async () => {
        await ensureSignIn(env.DB, env.AUTH_SECRET);
        await clearSignIn(env.DB);
    });

    it("stops resolving the session once the sign-in rows are erased, because the session cache is off", async () => {
        expect.assertions(3);

        const auth = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB });
        const signedUp = await auth.api.signUpEmail({ body: CREDENTIALS, returnHeaders: true });
        const userId = signedUp.response.user.id;
        const headers = new Headers({
            cookie: signedUp.headers
                .getSetCookie()
                .map((cookie) => cookie.split(";")[0])
                .join("; "),
        });

        await expect(auth.api.getSession({ headers })).resolves.toMatchObject({ user: { id: userId } });

        await eraseAuth(authDatabaseFrom({ DB: env.DB }), authData, userId, new Date(), deleteRow);

        await expect(auth.api.getSession({ headers })).resolves.toBeNull();

        const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?').bind(userId).first<{ count: number }>();

        expect(remaining?.count).toBe(0);
    });

    it("refuses a new session for an erased subject, because the user row is gone", async () => {
        expect.assertions(1);

        const auth = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB });
        const signedUp = await auth.api.signUpEmail({ body: CREDENTIALS, returnHeaders: true });
        const userId = signedUp.response.user.id;

        await eraseAuth(authDatabaseFrom({ DB: env.DB }), authData, userId, new Date(), deleteRow);

        const now = Date.now();

        await expect(
            env.DB.prepare('INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)')
                .bind(`${userId}-late`, now + 86_400_000, `${userId}-late-token`, now, now, userId)
                .run(),
        ).rejects.toThrow(FOREIGN_KEY_REFUSAL);
    });
});
