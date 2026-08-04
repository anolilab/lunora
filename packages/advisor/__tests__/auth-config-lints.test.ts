import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorAuthConfig } from "../src/auth-config";
import authCsrfCheckDisabled from "../src/lints/static/auth-csrf-check-disabled";
import authEmailVerificationDisabled from "../src/lints/static/auth-email-verification-disabled";
import authScimWithoutTransactions from "../src/lints/static/auth-scim-without-transactions";
import authSecureCookiesDisabled from "../src/lints/static/auth-secure-cookies-disabled";
import authSessionFreshageZero from "../src/lints/static/auth-session-freshage-zero";
import authTrustedOriginsWildcard from "../src/lints/static/auth-trusted-origins-wildcard";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

/** A hardened, fully-safe `createAuth` config; spread overrides to vary one fact at a time. */
const authConfig = (overrides: Partial<AdvisorAuthConfig> = {}): AdvisorAuthConfig => {
    return {
        analyzable: true,
        disableCsrfCheck: false,
        emailPasswordEnabled: false,
        exportName: "auth",
        file: "auth",
        line: 1,
        requireEmailVerification: false,
        scimOnNonTransactionalAdapter: false,
        secureCookiesDisabled: false,
        sessionFreshAgeZero: false,
        trustedOriginsWildcard: false,
        ...overrides,
    };
};

describe("auth_trusted_origins_wildcard", () => {
    it("flags an analyzable config with a trustedOrigins wildcard", () => {
        expect.assertions(2);

        const findings = authTrustedOriginsWildcard.run({ authConfigs: [authConfig({ trustedOriginsWildcard: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "auth_trusted_origins_wildcard:auth:1",
            level: "ERROR",
            metadata: { exportName: "auth", file: "auth", line: 1 },
            name: "auth_trusted_origins_wildcard",
        });
    });

    it("ignores a config without a wildcard, and an unanalyzable config even when the flag is set", () => {
        expect.assertions(1);

        const configs = [authConfig(), authConfig({ analyzable: false, trustedOriginsWildcard: true })];

        expect(authTrustedOriginsWildcard.run({ authConfigs: configs, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the feeder supplies no auth-config evidence", () => {
        expect.assertions(1);

        expect(authTrustedOriginsWildcard.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("auth_csrf_check_disabled", () => {
    it("flags an analyzable config with CSRF checking disabled", () => {
        expect.assertions(2);

        const findings = authCsrfCheckDisabled.run({ authConfigs: [authConfig({ disableCsrfCheck: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "ERROR", name: "auth_csrf_check_disabled" });
    });

    it("ignores a config that leaves CSRF checking on, and an unanalyzable config even when the flag is set", () => {
        expect.assertions(1);

        const configs = [authConfig(), authConfig({ analyzable: false, disableCsrfCheck: true })];

        expect(authCsrfCheckDisabled.run({ authConfigs: configs, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the feeder supplies no auth-config evidence", () => {
        expect.assertions(1);

        expect(authCsrfCheckDisabled.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("auth_secure_cookies_disabled", () => {
    it("flags an analyzable config with secure cookies disabled", () => {
        expect.assertions(2);

        const findings = authSecureCookiesDisabled.run({ authConfigs: [authConfig({ secureCookiesDisabled: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "ERROR", name: "auth_secure_cookies_disabled" });
    });

    it("ignores a config that leaves secure cookies on, and an unanalyzable config even when the flag is set", () => {
        expect.assertions(1);

        const configs = [authConfig(), authConfig({ analyzable: false, secureCookiesDisabled: true })];

        expect(authSecureCookiesDisabled.run({ authConfigs: configs, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the feeder supplies no auth-config evidence", () => {
        expect.assertions(1);

        expect(authSecureCookiesDisabled.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("auth_email_verification_disabled", () => {
    it("flags email/password enabled with no requireEmailVerification", () => {
        expect.assertions(2);

        const findings = authEmailVerificationDisabled.run({ authConfigs: [authConfig({ emailPasswordEnabled: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", name: "auth_email_verification_disabled" });
    });

    it("ignores email/password enabled with requireEmailVerification, email/password disabled, and an unanalyzable config", () => {
        expect.assertions(1);

        const configs = [
            authConfig({ emailPasswordEnabled: true, requireEmailVerification: true }),
            authConfig({ emailPasswordEnabled: false }),
            authConfig({ analyzable: false, emailPasswordEnabled: true }),
        ];

        expect(authEmailVerificationDisabled.run({ authConfigs: configs, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the feeder supplies no auth-config evidence", () => {
        expect.assertions(1);

        expect(authEmailVerificationDisabled.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("auth_session_freshage_zero", () => {
    it("flags an analyzable config with session.freshAge zeroed out", () => {
        expect.assertions(2);

        const findings = authSessionFreshageZero.run({ authConfigs: [authConfig({ sessionFreshAgeZero: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", name: "auth_session_freshage_zero" });
    });

    it("ignores a config with a non-zero freshAge, and an unanalyzable config even when the flag is set", () => {
        expect.assertions(1);

        const configs = [authConfig(), authConfig({ analyzable: false, sessionFreshAgeZero: true })];

        expect(authSessionFreshageZero.run({ authConfigs: configs, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the feeder supplies no auth-config evidence", () => {
        expect.assertions(1);

        expect(authSessionFreshageZero.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("authScimWithoutTransactions", () => {
    it("flags scim() on an adapter with no native transactions", async () => {
        expect.assertions(2);

        const findings = authScimWithoutTransactions.run({ authConfigs: [authConfig({ scimOnNonTransactionalAdapter: true })], ...schema() } as never);

        // This exact pairing shipped in documentation once and throws on the first SCIM
        // request; there is no reason for build time not to say so.
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe("ERROR");
    });

    it("stays quiet when the adapter does have transactions", async () => {
        expect.assertions(1);

        const findings = authScimWithoutTransactions.run({ authConfigs: [authConfig()], ...schema() } as never);

        expect(findings).toStrictEqual([]);
    });

    it("skips an opaque config rather than guessing at its database", async () => {
        expect.assertions(1);

        const findings = authScimWithoutTransactions.run({
            authConfigs: [authConfig({ analyzable: false, scimOnNonTransactionalAdapter: true })],
            ...schema(),
        } as never);

        expect(findings).toStrictEqual([]);
    });
});
