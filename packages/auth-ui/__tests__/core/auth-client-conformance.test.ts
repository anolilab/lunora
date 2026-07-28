import { admin } from "better-auth/plugins/admin";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { twoFactor } from "better-auth/plugins/two-factor";
import { describe, expect, it } from "vitest";

/**
 * `core/types.ts` hand-writes the slice of better-auth's client the controllers
 * call, and `__tests__/fake-client.ts` hand-writes a stub of the same shape. On
 * their own those two confirm each other in a closed loop: if better-auth
 * renames an endpoint, both stay consistent and the first signal is a runtime
 * failure in a *user's copied code* — which they now own and we cannot patch.
 *
 * # Why this checks the server plugins and not the client
 *
 * The obvious test — build a real `createAuthClient` and assert the methods
 * exist — cannot fail. It returns a dynamic-path `Proxy`, so
 * `client.totallyMadeUp.nope` is also a function; this is the same property
 * `flow-gate.ts` exists because of. A presence check against it is theatre.
 *
 * The **server** plugins do declare their real routes, so that is what this
 * asserts against: each client call we make is derived from an endpoint path,
 * and a renamed or removed route fails here instead of in a user's project.
 */
const declaredPaths = (plugin: { endpoints?: Record<string, { path?: string } | undefined> }): string[] =>
    Object.values(plugin.endpoints ?? {})
        .map((endpoint) => endpoint?.path)
        .filter((path): path is string => typeof path === "string");

/** The routes behind the calls `core/types.ts` declares, by plugin. */
const EXPECTED: ReadonlyArray<[string, string[], string[]]> = [
    [
        "organization",
        declaredPaths(organization()),
        [
            "/organization/accept-invitation",
            "/organization/cancel-invitation",
            "/organization/create",
            "/organization/delete",
            "/organization/get-full-organization",
            "/organization/get-invitation",
            "/organization/invite-member",
            "/organization/leave",
            "/organization/list",
            "/organization/list-invitations",
            "/organization/list-user-invitations",
            "/organization/reject-invitation",
            "/organization/remove-member",
            "/organization/set-active",
            "/organization/update",
            "/organization/update-member-role",
        ],
    ],
    [
        "admin",
        declaredPaths(admin()),
        [
            "/admin/ban-user",
            "/admin/impersonate-user",
            "/admin/list-users",
            "/admin/remove-user",
            "/admin/set-role",
            "/admin/stop-impersonating",
            "/admin/unban-user",
        ],
    ],
    [
        "two-factor",
        declaredPaths(twoFactor()),
        [
            "/two-factor/disable",
            "/two-factor/enable",
            "/two-factor/generate-backup-codes",
            "/two-factor/verify-backup-code",
            "/two-factor/verify-otp",
            "/two-factor/verify-totp",
        ],
    ],
    ["multi-session", declaredPaths(multiSession()), ["/multi-session/list-device-sessions", "/multi-session/revoke", "/multi-session/set-active"]],
    ["device-authorization", declaredPaths(deviceAuthorization()), ["/device/approve", "/device/deny"]],
    [
        "phone-number",
        declaredPaths(phoneNumber()),
        ["/phone-number/request-password-reset", "/phone-number/reset-password", "/phone-number/send-otp", "/phone-number/verify", "/sign-in/phone-number"],
    ],
    [
        "email-otp",
        declaredPaths(emailOTP({ sendVerificationOTP: () => Promise.resolve() })),
        ["/email-otp/reset-password", "/email-otp/send-verification-otp", "/sign-in/email-otp"],
    ],
];

describe("authClient conformance", () => {
    it.each(EXPECTED.map(([name, actual, expected]) => [name, actual, expected]))("%s still declares every route we call", (_name, actual, expected) => {
        expect.assertions(1);

        expect((expected).filter((path) => !(actual).includes(path))).toStrictEqual([]);
    });
});
