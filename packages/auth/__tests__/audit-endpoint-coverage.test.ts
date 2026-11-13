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
    oauthDeviceAuthorization,
    oauthProvider,
    oneTap,
    oneTimeToken,
    organization,
    passkey,
    phoneNumber,
    scim,
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
    "/sso/delete-provider": "sso-provider-delete",
    "/sso/get-provider": undefined,
    "/sso/providers": undefined,
    "/sso/register": "sso-provider-register",
    "/sso/update-provider": "sso-provider-update",
    "/sso/callback": "sign-in",
    "/sso/callback/:providerId": "sign-in",
    "/sso/saml2/logout/:providerId": "sign-out",
    "/sso/saml2/sp/acs/:providerId": "sign-in",
    "/sso/saml2/sp/metadata": undefined,
    "/sso/saml2/sp/slo/:providerId": "sign-out",
    "/sign-in/sso": "sign-in-initiated",
};

/** `"METHOD /path"` per (method, endpoint): the same path can serve different verbs. */
const methodKeysOf = (endpoints: Record<string, { options?: { method?: string | string[] }; path?: string }> | undefined): string[] =>
    Object.values(endpoints ?? {}).flatMap((endpoint) => {
        const { path } = endpoint;

        if (typeof path !== "string") {
            return [];
        }

        // An endpoint without a method becomes a key no EXPECTED row has, so the set comparison fails loudly.
        const methods = endpoint.options?.method ?? "NO_METHOD";

        return (Array.isArray(methods) ? methods : [methods]).map((method) => `${method} ${path}`);
    });

const enumeratedByMethod: string[] = [
    ...methodKeysOf(organization({ dynamicAccessControl: { enabled: true }, teams: { enabled: true } }).endpoints),
    ...methodKeysOf(oauthProvider({ consentPage: "/consent", loginPage: "/login" }).endpoints),
    ...methodKeysOf(oauthDeviceAuthorization({}).endpoints),
    ...methodKeysOf(scim({ authentication: { verifyBearerToken: async () => null }, connections: [] }).endpoints),
];

const EXPECTED_BY_METHOD: Record<string, AuthAuditEvent | undefined> = {
    "DELETE /admin/oauth2/resources/:identifier": "oauth-resource-delete",
    "DELETE /admin/oauth2/resources/:identifier/clients/:client_id": "oauth-resource-client-unlink",
    "DELETE /scim/v2/Groups/:groupId": "scim-group-delete",
    "DELETE /scim/v2/Users/:userId": "scim-user-delete",
    "GET /.well-known/oauth-authorization-server": undefined,
    "GET /.well-known/openid-configuration": undefined,
    "GET /admin/oauth2/resources": undefined,
    "GET /admin/oauth2/resources/:identifier": undefined,
    "GET /device": undefined,
    "GET /oauth2/authorize": undefined,
    "GET /oauth2/end-session": "sign-out",
    "GET /oauth2/get-client": undefined,
    "GET /oauth2/get-clients": undefined,
    "GET /oauth2/get-consent": undefined,
    "GET /oauth2/get-consents": undefined,
    "GET /oauth2/public-client": undefined,
    "GET /oauth2/userinfo": undefined,
    "GET /organization/get-active-member": undefined,
    "GET /organization/get-active-member-role": undefined,
    "GET /organization/get-full-organization": undefined,
    "GET /organization/get-invitation": undefined,
    "GET /organization/get-organization": undefined,
    "GET /organization/list": undefined,
    "GET /organization/list-invitations": undefined,
    "GET /organization/list-members": undefined,
    "GET /organization/list-team-members": undefined,
    "GET /organization/list-teams": undefined,
    "GET /organization/list-user-invitations": undefined,
    "GET /organization/list-user-teams": undefined,
    "GET /scim/v2/Groups": undefined,
    "GET /scim/v2/Groups/:groupId": undefined,
    "GET /scim/v2/ResourceTypes": undefined,
    "GET /scim/v2/ResourceTypes/:resourceTypeId": undefined,
    "GET /scim/v2/Schemas": undefined,
    "GET /scim/v2/Schemas/:schemaId": undefined,
    "GET /scim/v2/ServiceProviderConfig": undefined,
    "GET /scim/v2/Users": undefined,
    "GET /scim/v2/Users/:userId": undefined,
    "PATCH /admin/oauth2/resources/:identifier": "oauth-resource-update",
    "PATCH /admin/oauth2/update-client": "oauth-client-update",
    "PATCH /scim/v2/Groups/:groupId": "scim-group-update",
    "PATCH /scim/v2/Users/:userId": "scim-user-update",
    "POST /admin/oauth2/create-client": "oauth-client-create",
    "POST /admin/oauth2/resources": "oauth-resource-create",
    "POST /admin/oauth2/resources/:identifier/clients/:client_id": "oauth-resource-client-link",
    "POST /device/approve": "device-approve",
    "POST /device/code": undefined,
    "POST /device/deny": "device-deny",
    "POST /device/token": "sign-in",
    "POST /oauth2/authorize": undefined,
    "POST /oauth2/client/rotate-keys": "oauth-client-keys-rotate",
    "POST /oauth2/client/rotate-secret": "oauth-client-secret-rotate",
    "POST /oauth2/consent": "oauth-consent",
    "POST /oauth2/continue": undefined,
    "POST /oauth2/create-client": "oauth-client-create",
    "POST /oauth2/delete-client": "oauth-client-delete",
    "POST /oauth2/delete-consent": "oauth-consent-revoke",
    "POST /oauth2/end-session": "sign-out",
    "POST /oauth2/end-session/confirm": "sign-out",
    "POST /oauth2/introspect": undefined,
    "POST /oauth2/public-client-prelogin": undefined,
    "POST /oauth2/register": "oauth-client-create",
    "POST /oauth2/revoke": "oauth-token-revoke",
    "POST /oauth2/token": "oauth-token-issue",
    "POST /oauth2/update-client": "oauth-client-update",
    "POST /oauth2/update-consent": "oauth-consent-update",
    "POST /oauth2/userinfo": undefined,
    "POST /organization/accept-invitation": "org-invitation-accept",
    "POST /organization/add-team-member": "org-team-member-add",
    "POST /organization/cancel-invitation": "org-invitation-cancel",
    "POST /organization/check-slug": undefined,
    "POST /organization/create": "org-create",
    "POST /organization/create-team": "org-team-create",
    "POST /organization/delete": "org-delete",
    "POST /organization/has-permission": undefined,
    "POST /organization/invite-member": "org-invitation-create",
    "POST /organization/leave": "org-member-leave",
    "POST /organization/reject-invitation": "org-invitation-reject",
    "POST /organization/remove-member": "org-member-remove",
    "POST /organization/remove-team": "org-team-remove",
    "POST /organization/remove-team-member": "org-team-member-remove",
    "POST /organization/set-active": "org-switch",
    "POST /organization/set-active-team": "org-team-switch",
    "POST /organization/create-role": "org-role-change",
    "POST /organization/delete-role": "org-role-change",
    "POST /organization/update-role": "org-role-change",
    "GET /organization/get-role": undefined,
    "GET /organization/list-roles": undefined,
    "POST /organization/update": "org-update",
    "POST /organization/update-member-role": "org-member-role-change",
    "POST /organization/update-team": "org-team-update",
    "POST /scim/v2/Groups": "scim-group-create",
    "POST /scim/v2/Users": "scim-user-create",
    "PUT /scim/v2/Groups/:groupId": "scim-group-update",
    "PUT /scim/v2/Users/:userId": "scim-user-update",
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

    it("classifies every organization, OAuth-provider and SCIM endpoint, and nothing is unaccounted for", () => {
        expect.assertions(1);

        const byName = (left: string, right: string): number => left.localeCompare(right);

        expect([...new Set(enumeratedByMethod)].toSorted(byName)).toStrictEqual(Object.keys(EXPECTED_BY_METHOD).toSorted(byName));
    });

    it("classifies each of those endpoints by method and path", () => {
        expect.hasAssertions();

        for (const [key, event] of Object.entries(EXPECTED_BY_METHOD)) {
            const separator = key.indexOf(" ");
            const method = key.slice(0, separator);
            const path = key.slice(separator + 1);

            expect(eventForPath(path, method), key).toBe(event);
            expect(eventForPath(`/api/auth${path}`, method), `/api/auth ${key}`).toBe(event);
        }
    });

    it("leaves a multiplexed path unclassified when no method is known (direct server calls)", () => {
        expect.hasAssertions();

        expect(eventForPath("/scim/v2/Users")).toBeUndefined();
        expect(eventForPath("/scim/v2/Users/:userId")).toBeUndefined();
        expect(eventForPath("/admin/oauth2/resources/:identifier")).toBeUndefined();
    });

    it("matches a concrete path against a parameterised row", () => {
        expect.hasAssertions();

        expect(eventForPath("/api/auth/scim/v2/Users/u-123", "DELETE")).toBe("scim-user-delete");
        expect(eventForPath("/api/auth/scim/v2/Users/u-123", "GET")).toBeUndefined();
    });
});
