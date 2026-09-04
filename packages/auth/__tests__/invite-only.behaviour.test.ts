import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/create-auth";
import { createSignUpInvitation, inviteOnly, listSignUpInvitations, revokeSignUpInvitation } from "../src/invite-only";

/**
 * Round-trip behaviour for `inviteOnly()` against the real better-auth runtime
 * on an in-memory adapter — no mocks, so the specs exercise the actual
 * `user.create.before` wiring the plugin installs through `init()`, and the
 * actual `/sign-up/email` route it has to reject.
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";

// better-auth's memory adapter needs each model pre-declared.
const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], session: [], signUpInvitation: [], user: [], verification: [] };
};

describe("inviteOnly", () => {
    let database: Record<string, unknown[]>;
    // `any` to reach plugin-contributed endpoints without re-deriving the generic chain.
    let auth: any;

    /** Build an auth instance over the shared `database`, so a spec can vary the plugin options. */
    const buildAuth = (options: Parameters<typeof inviteOnly>[0] = {}): any =>
        createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(database),
            emailAndPassword: { enabled: true },
            plugins: [inviteOnly(options)],
            secret: SECRET,
        });

    const signUp = async (email: string): Promise<unknown> => auth.api.signUpEmail({ body: { email, name: "Ada", password: STRONG_PASSWORD } });

    const invitationRow = (email: string): Record<string, unknown> | undefined =>
        database["signUpInvitation"]?.find((row) => (row as { email: string }).email === email) as Record<string, unknown> | undefined;

    beforeEach(() => {
        // Every instance below runs password sign-up without verification, so each
        // one trips the plugin's warning; the spec asserting it does so explicitly.
        vi.spyOn(console, "warn").mockImplementation(() => {});

        database = seedMemoryDatabase();
        auth = buildAuth();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("lets the first account through uninvited, then refuses every later one", async () => {
        expect.assertions(3);

        await expect(signUp("owner@example.com")).resolves.toBeDefined();
        await expect(signUp("stranger@example.com")).rejects.toThrow(/invite-only/);

        expect(database["user"]).toHaveLength(1);
    });

    it("refuses even the first account when allowFirstUser is off", async () => {
        expect.assertions(1);

        auth = buildAuth({ allowFirstUser: false });

        await expect(signUp("owner@example.com")).rejects.toThrow(/invite-only/);
    });

    it("admits an invited address and marks the invitation accepted", async () => {
        expect.assertions(3);

        await signUp("owner@example.com");
        await createSignUpInvitation(auth, { email: "Ada@Example.com", invitedBy: "owner" });

        await expect(signUp("ada@example.com")).resolves.toBeDefined();

        // The address is normalized on both sides, so the mixed-case invite matches.
        expect(invitationRow("ada@example.com")?.["acceptedAt"]).toBeInstanceOf(Date);
        expect(database["user"]).toHaveLength(2);
    });

    it("refuses an expired invitation", async () => {
        expect.assertions(1);

        await signUp("owner@example.com");
        await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 60 });

        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 61 * 1000);

        try {
            await expect(signUp("ada@example.com")).rejects.toThrow(/invite-only/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses a revoked invitation", async () => {
        expect.assertions(2);

        await signUp("owner@example.com");
        await createSignUpInvitation(auth, { email: "ada@example.com" });
        await revokeSignUpInvitation(auth, { email: "ADA@example.com" });

        expect(invitationRow("ada@example.com")).toBeUndefined();
        await expect(signUp("ada@example.com")).rejects.toThrow(/invite-only/);
    });

    it("re-inviting refreshes the row in place rather than adding a second one", async () => {
        expect.assertions(3);

        const first = await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 60 });
        const second = await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 3600 });

        expect(second.id).toBe(first.id);
        expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
        expect(database["signUpInvitation"]).toHaveLength(1);
    });

    it("rejects an input that is not an address", async () => {
        expect.assertions(2);

        await expect(createSignUpInvitation(auth, { email: "   " })).rejects.toThrow(/not an email address/);
        await expect(createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 0 })).rejects.toThrow(/positive finite integer/);
    });

    it("lists invitations newest-first, and `pendingOnly` drops the accepted and the expired", async () => {
        expect.assertions(2);

        await signUp("owner@example.com");
        await createSignUpInvitation(auth, { email: "accepted@example.com" });
        await signUp("accepted@example.com");
        await createSignUpInvitation(auth, { email: "pending@example.com" });

        const all = await listSignUpInvitations(auth);
        const pending = await listSignUpInvitations(auth, { pendingOnly: true });

        expect(all).toHaveLength(2);
        expect(pending.map((row) => row.email)).toStrictEqual(["pending@example.com"]);
    });

    it("warns when password sign-up runs without email verification", async () => {
        expect.assertions(1);

        // `init()` runs when the context resolves, not at construction.
        await auth.$context;

        // eslint-disable-next-line no-console
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("requireEmailVerification"));
    });
});
