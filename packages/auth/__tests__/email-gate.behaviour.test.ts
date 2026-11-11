import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/create-auth";
import { withEmailGate } from "../src/email-gate";

/**
 * Round-trip behaviour for `withEmailGate` against the real better-auth runtime on an
 * in-memory adapter, with no mocks. This pins the `user.update.before` hook on
 * better-auth's real update path, which every address-change route uses
 * (`internalAdapter.updateUser`, reached by `/change-email`, the email-OTP change and
 * `AuthAdmin.updateUser`).
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";

// better-auth's memory adapter needs each model pre-declared.
const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], session: [], user: [], verification: [] };
};

describe("withEmailGate — better-auth round trip", () => {
    const buildAuth = (database: Record<string, unknown[]>): any =>
        createAuth(
            withEmailGate(
                {
                    baseURL: "http://localhost",
                    database: memoryAdapter(database),
                    emailAndPassword: { enabled: true },
                    secret: SECRET,
                },
                { denyDomains: ["blocked-domain.com"] },
            ),
        );

    it("refuses moving an account to a denied domain, and keeps the old address", async () => {
        expect.assertions(2);

        const database = seedMemoryDatabase();
        const auth = buildAuth(database);

        await auth.api.signUpEmail({ body: { email: "ada@example.com", name: "Ada", password: STRONG_PASSWORD } });

        const context = await auth.$context;
        const { id } = database["user"]![0] as { id: string };

        await expect(context.internalAdapter.updateUser(id, { email: "ada@blocked-domain.com" })).rejects.toMatchObject({
            body: { code: "EMAIL_DOMAIN_BLOCKED" },
        });
        expect((database["user"]![0] as { email: string }).email).toBe("ada@example.com");
    });

    it("lets an account move to an allowed address", async () => {
        expect.assertions(2);

        const database = seedMemoryDatabase();
        const auth = buildAuth(database);

        await auth.api.signUpEmail({ body: { email: "ada@example.com", name: "Ada", password: STRONG_PASSWORD } });

        const context = await auth.$context;
        const { id } = database["user"]![0] as { id: string };

        await expect(context.internalAdapter.updateUser(id, { email: "ada@example.org" })).resolves.toBeDefined();
        expect((database["user"]![0] as { email: string }).email).toBe("ada@example.org");
    });

    it("refuses signing up on the denied domain (unchanged creation behaviour)", async () => {
        expect.assertions(2);

        const database = seedMemoryDatabase();
        const auth = buildAuth(database);

        await expect(auth.api.signUpEmail({ body: { email: "eve@blocked-domain.com", name: "Eve", password: STRONG_PASSWORD } })).rejects.toMatchObject({
            body: { code: "EMAIL_DOMAIN_BLOCKED" },
        });
        expect(database["user"]).toHaveLength(0);
    });
});
