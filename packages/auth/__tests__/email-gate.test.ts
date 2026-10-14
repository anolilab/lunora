import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailGateHookConfig } from "../src/email-gate";
import { emailGateDatabaseHooks, withEmailGate } from "../src/email-gate";
import type { EmailClassification } from "../src/email-guard";

/**
 * Coverage for the better-auth `databaseHooks.user.create.before` wiring — the
 * only gate on better-auth's native `/sign-up/email` route (never passes through
 * a Lunora procedure middleware, see `../src/email-gate.ts`'s docblock). The
 * classifier (`assertEmailAllowed`) is already covered by `email-guard.test.ts`;
 * here it is stubbed so these specs assert composition and error-mapping only,
 * with no better-auth server and no database.
 */

type AssertEmailAllowed = typeof import("../src/email-guard").assertEmailAllowed;

// `email-gate.ts` imports `assertEmailAllowed` statically (unlike email-guard.test.ts's
// MX mock, which only stubs a dependency loaded via a runtime dynamic `import()`), so the
// factory below runs during module linking, before an ordinary top-level `const` would be
// initialized. `vi.hoisted` runs first and sidesteps the TDZ.
const { assertEmailAllowed } = vi.hoisted(() => {
    return { assertEmailAllowed: vi.fn<AssertEmailAllowed>() };
});

vi.mock(import("../src/email-guard"), () => {
    return { assertEmailAllowed };
});

// Mirrors the private type derivation in `../src/email-gate.ts` — derived from the
// public `BetterAuthOptions` shape so a better-auth rename fails to compile here too.
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;
type OnClassify = NonNullable<EmailGateHookConfig["onClassify"]>;

/** Pull the `user.create.before` hook out of a `databaseHooks` fragment, failing loudly if it's missing. */
const getBefore = (hooks: DatabaseHooks): UserCreateBefore => {
    const before = hooks.user?.create?.before;

    if (!before) {
        throw new Error("expected a user.create.before hook");
    }

    return before;
};

// The hook only ever reads `.email` off this object at runtime; the full better-auth
// `User` shape (id/name/createdAt/…) is irrelevant to these specs.
const fakeUser = (overrides: Record<string, unknown>): Parameters<UserCreateBefore>[0] => overrides as unknown as Parameters<UserCreateBefore>[0];

const businessClassification: EmailClassification = { domain: "acme-corp.example", emailClass: "business" };

describe("email-gate", () => {
    beforeEach(() => {
        assertEmailAllowed.mockClear();
    });

    describe("emailGateDatabaseHooks — passthrough for a non-string/absent email", () => {
        it.each([
            ["absent", {}],
            ["undefined", { email: undefined }],
            ["an empty string", { email: "" }],
            ["a number", { email: 12_345 }],
            ["an object", { email: { toString: () => "x@y.test" } }],
        ])("resolves without calling the classifier when email is %s", async (_label, overrides) => {
            expect.assertions(2);

            const before = getBefore(emailGateDatabaseHooks({}));

            await expect(before(fakeUser(overrides), null)).resolves.toBeUndefined();
            expect(assertEmailAllowed).not.toHaveBeenCalled();
        });
    });

    describe("emailGateDatabaseHooks — classifier rejection", () => {
        it("rejects a blocked domain with a coded APIError", async () => {
            expect.assertions(3);

            assertEmailAllowed.mockRejectedValueOnce(new LunoraError("EMAIL_DOMAIN_BLOCKED", "blocked"));

            const before = getBefore(emailGateDatabaseHooks({}));
            const rejection = before(fakeUser({ email: "spammer@mailinator.com" }), null);

            await expect(rejection).rejects.toBeInstanceOf(APIError);
            await expect(rejection).rejects.toMatchObject({ status: "BAD_REQUEST", statusCode: 400 });
            await expect(rejection).rejects.toMatchObject({ body: { code: "EMAIL_DOMAIN_BLOCKED" } });
        });

        it("propagates a non-LunoraError from the classifier unwrapped", async () => {
            expect.assertions(1);

            const rawError = new Error("classifier blew up");

            assertEmailAllowed.mockRejectedValueOnce(rawError);

            const before = getBefore(emailGateDatabaseHooks({}));

            await expect(before(fakeUser({ email: "cto@acme-corp.example" }), null)).rejects.toBe(rawError);
        });

        // Every LunoraError assertEmailAllowed can actually throw today (VALIDATION_ERROR,
        // EMAIL_DOMAIN_BLOCKED, EMAIL_UNDELIVERABLE) carries status 400 — so the 422/429
        // arms of the private `statusString` mapper are unreachable via any real call path
        // and are only exercised here through the stubbed classifier. See plan 325 §9.
        it.each([
            { code: "VALIDATION_ERROR" as const, expectedStatus: "BAD_REQUEST", expectedStatusCode: 400 },
            { code: "UNPROCESSABLE" as const, expectedStatus: "UNPROCESSABLE_ENTITY", expectedStatusCode: 422 },
            { code: "TOO_MANY_REQUESTS" as const, expectedStatus: "TOO_MANY_REQUESTS", expectedStatusCode: 429 },
            // No LunoraError status maps to anything outside {400, 422, 429} today, so this
            // pins the `default` arm of `statusString` via a catalog code that carries an
            // unmapped status (500).
            { code: "INTERNAL" as const, expectedStatus: "INTERNAL_SERVER_ERROR", expectedStatusCode: 500 },
        ])("maps a $code LunoraError to $expectedStatus", async ({ code, expectedStatus, expectedStatusCode }) => {
            expect.assertions(2);

            assertEmailAllowed.mockRejectedValueOnce(new LunoraError(code, "boom"));

            const before = getBefore(emailGateDatabaseHooks({}));
            const rejection = before(fakeUser({ email: "x@example.test" }), null);

            await expect(rejection).rejects.toMatchObject({ status: expectedStatus, statusCode: expectedStatusCode });
            await expect(rejection).rejects.toMatchObject({ body: { code } });
        });
    });

    describe("emailGateDatabaseHooks — onClassify", () => {
        it("fires with the resolved classification on a pass", async () => {
            expect.assertions(1);

            assertEmailAllowed.mockResolvedValueOnce(businessClassification);

            const onClassify = vi.fn<OnClassify>();
            const before = getBefore(emailGateDatabaseHooks({ onClassify }));
            const user = fakeUser({ email: "cto@acme-corp.example" });

            await before(user, null);

            expect(onClassify).toHaveBeenCalledWith(businessClassification, user, null);
        });

        it("does not fire when the gate rejects", async () => {
            expect.assertions(2);

            assertEmailAllowed.mockRejectedValueOnce(new LunoraError("EMAIL_DOMAIN_BLOCKED", "blocked"));

            const onClassify = vi.fn<OnClassify>();
            const before = getBefore(emailGateDatabaseHooks({ onClassify }));

            await expect(before(fakeUser({ email: "spammer@mailinator.com" }), null)).rejects.toBeInstanceOf(APIError);
            expect(onClassify).not.toHaveBeenCalled();
        });
    });

    describe("withEmailGate — composition ordering", () => {
        it("uses the gate directly when the caller declared no existing before hook", async () => {
            expect.assertions(2);

            assertEmailAllowed.mockResolvedValueOnce(businessClassification);

            const merged = withEmailGate({}, {});

            await expect(getBefore(merged.databaseHooks!)(fakeUser({ email: "cto@acme-corp.example" }), null)).resolves.toBeUndefined();
            expect(assertEmailAllowed).toHaveBeenCalledTimes(1);
        });

        it("runs the gate before an existing user.create.before hook, and calls both on a pass", async () => {
            expect.assertions(3);

            const order: string[] = [];

            assertEmailAllowed.mockImplementationOnce(async () => {
                order.push("gate");

                return businessClassification;
            });

            const existingBefore = vi.fn<UserCreateBefore>(async () => {
                order.push("existing");
            });

            const options: BetterAuthOptions = { databaseHooks: { user: { create: { before: existingBefore } } } };
            const merged = withEmailGate(options, {});

            await getBefore(merged.databaseHooks!)(fakeUser({ email: "cto@acme-corp.example" }), null);

            expect(order).toStrictEqual(["gate", "existing"]);
            expect(assertEmailAllowed).toHaveBeenCalledTimes(1);
            expect(existingBefore).toHaveBeenCalledTimes(1);
        });

        it("never invokes the existing hook when the gate rejects", async () => {
            expect.assertions(2);

            assertEmailAllowed.mockRejectedValueOnce(new LunoraError("EMAIL_DOMAIN_BLOCKED", "blocked"));

            const existingBefore = vi.fn<UserCreateBefore>(async () => {});

            const options: BetterAuthOptions = { databaseHooks: { user: { create: { before: existingBefore } } } };
            const merged = withEmailGate(options, {});

            await expect(getBefore(merged.databaseHooks!)(fakeUser({ email: "spammer@mailinator.com" }), null)).rejects.toBeInstanceOf(APIError);
            expect(existingBefore).not.toHaveBeenCalled();
        });
    });
});
