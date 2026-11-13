/**
 * `eventForPath` classifies by endpoint path, and an endpoint it does not know
 * writes no audit row. Every endpoint the re-exported plugins serve is therefore
 * classified here on purpose, and a better-auth upgrade that adds one fails this
 * file until someone decides whether it is audited.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent } from "../src/audit";
import { eventForPath } from "../src/audit-hooks";
import {
    admin,
    anonymous,
    apiKey,
    deviceAuthorization,
    emailOTP,
    magicLink,
    multiSession,
    oneTap,
    oneTimeToken,
    passkey,
    phoneNumber,
    siwe,
    twoFactor,
    username,
} from "../src/plugins";
import { sso } from "../src/plugins-enterprise";

const pathsOf = (endpoints: Record<string, { path?: string }> | undefined): string[] =>
    Object.values(endpoints ?? {}).flatMap((endpoint) => (typeof endpoint.path === "string" ? [endpoint.path] : []));

const coreEndpoints = (): string[] => {
    // better-auth warns about the test secret's entropy on construction; the warning is not what this file tests.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
        const auth = betterAuth({
            baseURL: "http://localhost",
            database: memoryAdapter({}),
            emailAndPassword: { enabled: true },
            secret: "x".repeat(32),
        });

        return pathsOf(auth.api);
    } finally {
        warn.mockRestore();
    }
};

const enumerated: string[] = [
    ...coreEndpoints(),
    ...pathsOf(passkey().endpoints),
    ...pathsOf(oneTap().endpoints),
    ...pathsOf(admin().endpoints),
    ...pathsOf(oneTimeToken().endpoints),
    ...pathsOf(phoneNumber({ sendOTP: () => {} }).endpoints),
    ...pathsOf(siwe({ domain: "example.com", getNonce: async () => "nonce", verifyMessage: async () => true }).endpoints),
    ...pathsOf(anonymous().endpoints),
    ...pathsOf(emailOTP({ sendVerificationOTP: async () => {} }).endpoints),
    ...pathsOf(magicLink({ sendMagicLink: async () => {} }).endpoints),
    ...pathsOf(username().endpoints),
    ...pathsOf(multiSession().endpoints),
    ...pathsOf(deviceAuthorization().endpoints),
    ...pathsOf(twoFactor().endpoints),
    ...pathsOf(sso().endpoints),
    ...pathsOf(apiKey().endpoints),
];

const EXPECTED: Record<string, AuthAuditEvent | undefined> = {
    "/account-info": undefined,
    "/admin/ban-user": "admin-user-ban",
    "/admin/create-user": "admin-user-create",
    "/admin/get-user": undefined,
    "/admin/has-permission": undefined,
    "/admin/impersonate-user": "admin-impersonate-start",
    "/admin/list-user-sessions": undefined,
    "/admin/list-users": undefined,
    "/admin/remove-user": "admin-user-remove",
    "/admin/revoke-user-session": "admin-session-revoke",
    "/admin/revoke-user-sessions": "admin-session-revoke",
    "/admin/set-role": "admin-role-change",
    "/admin/set-user-password": "admin-password-set", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/admin/stop-impersonating": "admin-impersonate-stop",
    "/admin/unban-user": "admin-user-unban",
    "/admin/update-user": "admin-user-update",
    "/api-key/create": "api-key-create",
    "/api-key/delete": "api-key-delete",
    "/api-key/get": undefined,
    "/api-key/list": undefined,
    "/api-key/update": "api-key-update",
    "/callback/:id": "sign-in",
    "/change-email": "email-change-request",
    "/change-password": "password-change", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/delete-anonymous-user": "user-delete",
    "/delete-user": "user-delete",
    "/delete-user/callback": "user-delete",
    "/device": undefined,
    "/device/approve": "device-approve",
    "/device/code": undefined,
    "/device/deny": "device-deny",
    "/device/token": "sign-in",
    "/email-otp/change-email": "email-change",
    "/email-otp/check-verification-otp": undefined,
    "/email-otp/request-email-change": "email-change-request",
    "/email-otp/request-password-reset": "password-reset-request", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/email-otp/reset-password": "password-reset",
    "/email-otp/send-verification-otp": undefined,
    "/email-otp/verify-email": "email-verification",
    "/error": undefined,
    "/forget-password/email-otp": "password-reset-request", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/get-access-token": undefined,
    "/get-session": undefined,
    "/is-username-available": undefined,
    "/link-social": "account-link",
    "/list-accounts": undefined,
    "/list-sessions": undefined,
    "/magic-link/verify": "sign-in",
    "/multi-session/list-device-sessions": undefined,
    "/multi-session/revoke": "session-revoke",
    "/multi-session/set-active": "session-switch",
    "/ok": undefined,
    "/one-tap/callback": "sign-in",
    "/one-time-token/generate": "one-time-token-create",
    "/one-time-token/verify": "sign-in",
    "/passkey/delete-passkey": "passkey-remove",
    "/passkey/generate-authenticate-options": undefined,
    "/passkey/generate-register-options": undefined,
    "/passkey/list-user-passkeys": undefined,
    "/passkey/update-passkey": "passkey-rename",
    "/passkey/verify-authentication": "sign-in",
    "/passkey/verify-registration": "passkey-add",
    "/phone-number/request-password-reset": "password-reset-request", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/phone-number/reset-password": "password-reset",
    "/phone-number/send-otp": undefined,
    "/phone-number/verify": "sign-in",
    "/refresh-token": "token-refresh",
    "/request-password-reset": "password-reset-request", // secret-scanner:allow -- endpoint path or event name, not a credential
    "/reset-password": "password-reset",
    "/reset-password/:token": undefined,
    "/revoke-other-sessions": "session-revoke",
    "/revoke-session": "session-revoke",
    "/revoke-sessions": "session-revoke",
    "/send-verification-email": undefined,
    "/siwe/get-nonce": undefined,
    "/siwe/nonce": undefined,
    "/siwe/verify": "sign-in",
    "/sign-in/anonymous": "sign-in",
    "/sign-in/email": "sign-in",
    "/sign-in/email-otp": "sign-in",
    "/sign-in/magic-link": "sign-in-initiated",
    "/sign-in/phone-number": "sign-in",
    "/sign-in/social": "sign-in-initiated",
    "/sign-in/username": "sign-in",
    "/sign-out": "sign-out",
    "/sign-up/email": "sign-up",
    "/two-factor/disable": "mfa-disable",
    "/two-factor/enable": "mfa-enable",
    "/two-factor/generate-backup-codes": "mfa-backup-codes-regenerate",
    "/two-factor/get-totp-uri": undefined,
    "/two-factor/send-otp": undefined,
    "/two-factor/verify-backup-code": "sign-in",
    "/two-factor/verify-otp": "sign-in",
    "/two-factor/verify-totp": "sign-in",
    "/unlink-account": "account-unlink",
    "/update-session": undefined,
    "/update-user": undefined,
    "/verify-email": "email-verification",
    "/verify-password": undefined,
    // deferred: IdP configuration, not a user credential — see plan 561 §4.6
    "/sso/delete-provider": undefined,
    "/sso/get-provider": undefined,
    "/sso/providers": undefined,
    "/sso/register": undefined,
    "/sso/update-provider": undefined,
    "/sso/callback": "sign-in",
    "/sso/callback/:providerId": "sign-in",
    "/sso/saml2/logout/:providerId": "sign-out",
    "/sso/saml2/sp/acs/:providerId": "sign-in",
    "/sso/saml2/sp/metadata": undefined,
    "/sso/saml2/sp/slo/:providerId": "sign-out",
    "/sign-in/sso": "sign-in-initiated",
};

describe("audit endpoint coverage — every re-exported plugin endpoint is classified on purpose", () => {
    it("classifies every endpoint the re-exported plugins serve, and nothing is unaccounted for", () => {
        expect.assertions(1);

        const byName = (left: string, right: string): number => left.localeCompare(right);

        expect([...new Set(enumerated)].toSorted(byName)).toStrictEqual(Object.keys(EXPECTED).toSorted(byName));
    });

    it("classifies each endpoint as recorded in EXPECTED", () => {
        expect.hasAssertions();

        for (const [path, event] of Object.entries(EXPECTED)) {
            expect(eventForPath(path), path).toBe(event);
        }
    });

    it("classifies the same endpoints with an app basePath in front", () => {
        expect.hasAssertions();

        for (const [path, event] of Object.entries(EXPECTED)) {
            expect(eventForPath(`/api/auth${path}`), `/api/auth${path}`).toBe(event);
        }
    });
});
