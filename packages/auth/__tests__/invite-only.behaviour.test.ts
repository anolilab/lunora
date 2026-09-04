import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { createSignUpInvitation, inviteOnly, listSignUpInvitations, pruneSignUpInvitations, revokeSignUpInvitation } from "../src/invite-only";

/**
 * Round-trip behaviour for `inviteOnly()` against the real better-auth runtime
 * on an in-memory adapter — no mocks, so the specs exercise the actual
 * `user.create.before` wiring the plugin installs through `init()`, and the
 * actual `/sign-up/email` route it has to reject.
 *
 * Two of these are regressions for gates that only fail in a configuration the
 * others do not run: `requireEmailVerification` (better-auth answers a 403 from
 * a create hook with a fabricated success, so the rejection has to be a 400) and
 * `AuthAdmin.createUser` (mints through the same internal adapter, so it is
 * gated too).
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";

// better-auth's memory adapter needs each model pre-declared.
const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], session: [], signUpInvitation: [], user: [], verification: [] };
};

describe("inviteOnly", () => {
    let database: Record<string, unknown[]>;
    // The endpoint map is generic over the resolved plugin set; `any` skips re-deriving
    // that chain for the two members these specs touch (`api.signUpEmail`, `$context`).
    let auth: any;

    /** Build an auth instance over the shared `database`, so a spec can vary the config. */
    const buildAuth = (pluginOptions: Parameters<typeof inviteOnly>[0] = {}, requireEmailVerification = false): any =>
        createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(database),
            emailAndPassword: { enabled: true, requireEmailVerification },
            plugins: [inviteOnly(pluginOptions)],
            secret: SECRET,
        });

    const signUp = async (email: string): Promise<unknown> => auth.api.signUpEmail({ body: { email, name: "Ada", password: STRONG_PASSWORD } });

    const invitationRow = (email: string): Record<string, unknown> | undefined =>
        database["signUpInvitation"]?.find((row) => (row as { email: string }).email === email) as Record<string, unknown> | undefined;

    beforeEach(() => {
        // Every instance below runs password sign-up without verification unless the
        // spec says otherwise, so each trips the plugin's warning; the spec asserting
        // it does so explicitly.
        vi.spyOn(console, "warn").mockImplementation(() => {});

        database = seedMemoryDatabase();
        auth = buildAuth();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("refuses every sign-up while no invitation exists", async () => {
        expect.assertions(2);

        await expect(signUp("stranger@example.com")).rejects.toThrow(/invite-only/);

        expect(database["user"]).toHaveLength(0);
    });

    it("admits the first account uninvited only when allowFirstUser is on, and only once", async () => {
        expect.assertions(3);

        auth = buildAuth({ allowFirstUser: true });

        await expect(signUp("owner@example.com")).resolves.toBeDefined();
        await expect(signUp("stranger@example.com")).rejects.toThrow(/invite-only/);

        expect(database["user"]).toHaveLength(1);
    });

    it("admits an invited address and marks the invitation spent", async () => {
        expect.assertions(3);

        await createSignUpInvitation(auth, { email: "Ada@Example.com", invitedBy: "owner" });

        await expect(signUp("ada@example.com")).resolves.toBeDefined();

        // The address is normalized on both sides, so the mixed-case invite matches.
        expect(invitationRow("ada@example.com")?.["acceptedAt"]).toBeInstanceOf(Date);
        expect(database["user"]).toHaveLength(1);
    });

    it("refuses an expired invitation", async () => {
        expect.assertions(1);

        await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 60 });

        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 61 * 1000);

        await expect(signUp("ada@example.com")).rejects.toThrow(/invite-only/);
    });

    it("refuses a revoked invitation", async () => {
        expect.assertions(2);

        await createSignUpInvitation(auth, { email: "ada@example.com" });
        await revokeSignUpInvitation(auth, { email: "ADA@example.com" });

        expect(invitationRow("ada@example.com")).toBeUndefined();
        await expect(signUp("ada@example.com")).rejects.toThrow(/invite-only/);
    });

    it("refuses a spent invitation, so a deleted account does not free the seat", async () => {
        expect.assertions(1);

        await createSignUpInvitation(auth, { email: "ada@example.com" });
        await signUp("ada@example.com");
        database["user"] = [];

        await expect(signUp("ada@example.com")).rejects.toThrow(/invite-only/);
    });

    /**
     * The gate rejects with a 400. A 403 is caught by better-auth's sign-up route
     * and answered with a synthetic user it never persisted, whenever
     * `requireEmailVerification` (or `autoSignIn: false`) is set — which would make
     * this plugin silently report success in its own recommended configuration.
     */
    it("still rejects — not with a fabricated success — under requireEmailVerification", async () => {
        expect.assertions(2);

        auth = buildAuth({}, true);

        await expect(signUp("stranger@example.com")).rejects.toThrow(/invite-only/);

        expect(database["user"]).toHaveLength(0);
    });

    it("gates the trusted admin plane too", async () => {
        expect.assertions(2);

        const adminApi = createAuthAdmin(auth);

        await expect(adminApi.createUser({ email: "stranger@example.com", name: "Ada" })).rejects.toThrow(/invite-only/);

        await createSignUpInvitation(auth, { email: "ada@example.com" });

        await expect(adminApi.createUser({ email: "ada@example.com", name: "Ada" })).resolves.toBeDefined();
    });

    /**
     * The docs claim every account-minting path is gated, but only `/sign-up/email`
     * and `AuthAdmin.createUser` have routes to exercise here. `createOAuthUser` is
     * the third shape — a provider callback minting an account — and it runs the
     * same `createWithHooks`, so this is the spec that keeps the claim honest
     * across an upstream bump.
     */
    it("gates an OAuth callback minting a new account", async () => {
        expect.assertions(2);

        const context = await auth.$context;

        await expect(
            context.internalAdapter.createOAuthUser(
                { email: "stranger@example.com", emailVerified: true, name: "Ada" },
                { accountId: "gh-1", providerId: "github" },
            ),
        ).rejects.toThrow(/invite-only/);

        await createSignUpInvitation(auth, { email: "ada@example.com" });

        await expect(
            context.internalAdapter.createOAuthUser(
                { email: "ada@example.com", emailVerified: true, name: "Ada" },
                { accountId: "gh-2", providerId: "github" },
            ),
        ).resolves.toBeDefined();
    });

    it("stops counting users once the bootstrap window has closed", async () => {
        expect.assertions(3);

        let counts = 0;

        auth = createAuth({
            baseURL: "http://localhost",
            database: (options: never) => {
                const inner = memoryAdapter(database)(options);

                return new Proxy(inner, {
                    get: (target, property, receiver) => {
                        if (property === "count") {
                            return async (...arguments_: unknown[]) => {
                                counts += 1;

                                return (target as unknown as { count: (...a: unknown[]) => Promise<number> }).count(...arguments_);
                            };
                        }

                        return Reflect.get(target, property, receiver) as unknown;
                    },
                });
            },
            emailAndPassword: { enabled: true },
            plugins: [inviteOnly({ allowFirstUser: true })],
            secret: SECRET,
        });

        await signUp("owner@example.com");
        const afterBootstrap = counts;

        await expect(signUp("one@example.com")).rejects.toThrow(/invite-only/);
        await expect(signUp("two@example.com")).rejects.toThrow(/invite-only/);

        // The first rejection observes a non-empty table and latches; the second
        // must not ask again.
        expect(counts).toBe(afterBootstrap + 1);
    });

    it("prunes the expired and unspent, and leaves the live and the spent alone", async () => {
        expect.assertions(3);

        await createSignUpInvitation(auth, { email: "spent@example.com", expiresInSeconds: 60 });
        await signUp("spent@example.com");
        await createSignUpInvitation(auth, { email: "dead@example.com", expiresInSeconds: 60 });
        await createSignUpInvitation(auth, { email: "live@example.com", expiresInSeconds: 3600 });

        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 61 * 1000);

        const pruned = await pruneSignUpInvitations(auth);
        const left = await listSignUpInvitations(auth);

        expect(pruned).toBe(1);
        expect(left.map((row) => row.email).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["live@example.com", "spent@example.com"]);
        expect(invitationRow("dead@example.com")).toBeUndefined();
    });

    it("re-inviting refreshes the row in place rather than adding a second one", async () => {
        expect.assertions(3);

        const first = await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 60 });
        const second = await createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 3600 });

        expect(second.id).toBe(first.id);
        expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
        expect(database["signUpInvitation"]).toHaveLength(1);
    });

    it("re-inviting a spent address re-opens the seat", async () => {
        expect.assertions(2);

        await createSignUpInvitation(auth, { email: "ada@example.com" });
        await signUp("ada@example.com");

        const reopened = await createSignUpInvitation(auth, { email: "ada@example.com" });

        expect(reopened.acceptedAt).toBeNull();
        expect(invitationRow("ada@example.com")?.["acceptedAt"]).toBeNull();
    });

    it("rejects an input that is not an address, or a TTL outside the accepted range", async () => {
        expect.assertions(4);

        await expect(createSignUpInvitation(auth, { email: "   " })).rejects.toThrow(/not an email address/);
        await expect(createSignUpInvitation(auth, { email: "@" })).rejects.toThrow(/not an email address/);
        await expect(createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 0 })).rejects.toThrow(/positive integer/);
        await expect(createSignUpInvitation(auth, { email: "ada@example.com", expiresInSeconds: 400 * 24 * 60 * 60 })).rejects.toThrow(/positive integer/);
    });

    it("lists invitations newest-first, and `pendingOnly` drops the spent and the expired", async () => {
        expect.assertions(2);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        await createSignUpInvitation(auth, { email: "accepted@example.com" });

        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        await createSignUpInvitation(auth, { email: "expired@example.com", expiresInSeconds: 60 });

        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        await createSignUpInvitation(auth, { email: "pending@example.com" });
        await signUp("accepted@example.com");

        const all = await listSignUpInvitations(auth);
        const pending = await listSignUpInvitations(auth, { pendingOnly: true });

        expect(all.map((row) => row.email)).toStrictEqual(["pending@example.com", "expired@example.com", "accepted@example.com"]);
        expect(pending.map((row) => row.email)).toStrictEqual(["pending@example.com"]);
    });

    describe("the admin plane", () => {
        it("reports the capability only when the plugin is installed", async () => {
            expect.assertions(2);

            await expect(createAuthAdmin(auth).capabilities()).resolves.toMatchObject({ inviteOnly: true });

            const plain = createAuth({ baseURL: "http://localhost", database: memoryAdapter(database), emailAndPassword: { enabled: true }, secret: SECRET });

            await expect(createAuthAdmin(plain).capabilities()).resolves.toMatchObject({ inviteOnly: false });
        });

        it("returns timestamps as epoch-ms, like every other row the plane hands back", async () => {
            expect.assertions(3);

            const invite = await createAuthAdmin(auth).createSignUpInvitation({ email: "Ada@Example.com", invitedBy: "owner" });

            expect(invite.email).toBe("ada@example.com");
            expect(typeof invite.expiresAt).toBe("number");
            expect(invite.acceptedAt ?? null).toBeNull();
        });

        it("pages newest-first and reports the unpaginated total", async () => {
            expect.assertions(2);

            const adminApi = createAuthAdmin(auth);

            vi.useFakeTimers();

            for (const [index, email] of ["a@example.com", "b@example.com", "c@example.com"].entries()) {
                vi.setSystemTime(new Date(`2026-01-0${String(index + 1)}T00:00:00Z`));
                // eslint-disable-next-line no-await-in-loop -- the point is a distinct createdAt per row.
                await adminApi.createSignUpInvitation({ email });
            }

            const first = await adminApi.listSignUpInvitations({ limit: 2 });

            expect(first.total).toBe(3);
            expect(first.rows.map((row) => row.email)).toStrictEqual(["c@example.com", "b@example.com"]);
        });

        it("revokes by address", async () => {
            expect.assertions(1);

            const adminApi = createAuthAdmin(auth);

            await adminApi.createSignUpInvitation({ email: "ada@example.com" });
            await adminApi.revokeSignUpInvitation({ email: "ADA@example.com" });

            await expect(adminApi.listSignUpInvitations({})).resolves.toMatchObject({ total: 0 });
        });
    });

    it("warns when password sign-up runs without email verification", async () => {
        expect.assertions(1);

        // `init()` runs when the context resolves, not at construction.
        await auth.$context;

        // eslint-disable-next-line no-console
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("requireEmailVerification"));
    });
});
