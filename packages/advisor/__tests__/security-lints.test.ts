import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorAdminRoute, AdvisorArgumentValidator, AdvisorProcedureProtection, AdvisorSecretLiteral, AdvisorSqlInterpolation } from "../src";
import { fromServerSchema } from "../src";
import adminRouteWithoutGuard from "../src/lints/static/admin-route-without-guard";
import hardcodedSecret from "../src/lints/static/hardcoded-secret";
import publicArgumentUsesAny from "../src/lints/static/public-argument-uses-any";
import publicMutationWithoutRatelimit from "../src/lints/static/public-mutation-without-ratelimit";
import sqlInjectionRisk from "../src/lints/static/sql-injection-risk";
import unboundedStringArgument from "../src/lints/static/unbounded-string-argument";
import userCreatingMutationWithoutCaptcha from "../src/lints/static/user-creating-mutation-without-captcha";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

/** A fully-unprotected public procedure; spread overrides to vary one fact at a time. */
const procedure = (overrides: Partial<AdvisorProcedureProtection> = {}): AdvisorProcedureProtection => {
    return {
        callsMail: false,
        exportName: "signUp",
        file: "signup",
        kind: "mutation",
        usesCaptcha: false,
        usesMask: false,
        usesRateLimit: false,
        usesRls: false,
        visibility: "public",
        writesUserTable: false,
        ...overrides,
    };
};

describe("public_mutation_without_ratelimit", () => {
    it("finds nothing without protection evidence (runtime caller)", () => {
        expect.assertions(1);
        expect(publicMutationWithoutRatelimit.run({ schema: schema() })).toHaveLength(0);
    });

    it("flags a public mutation with no rate limit and marks sensitive names", () => {
        expect.assertions(2);

        const findings = publicMutationWithoutRatelimit.run({ procedureProtections: [procedure({ exportName: "login" })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "public_mutation_without_ratelimit:signup:login",
            level: "WARN",
            metadata: { exportName: "login", sensitive: true },
            name: "public_mutation_without_ratelimit",
        });
    });

    it("ignores rate-limited writes, internal functions, and queries", () => {
        expect.assertions(1);

        const procedures = [
            procedure({ usesRateLimit: true }),
            procedure({ exportName: "b", visibility: "internal" }),
            procedure({ exportName: "c", kind: "query" }),
        ];

        expect(publicMutationWithoutRatelimit.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });
});

describe("user_creating_mutation_without_captcha", () => {
    it("flags a user-table write with no captcha", () => {
        expect.assertions(2);

        const findings = userCreatingMutationWithoutCaptcha.run({ procedureProtections: [procedure({ writesUserTable: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "user_creating_mutation_without_captcha:signup:signUp", metadata: { writesUserTable: true } });
    });

    it("flags a mail-sending write with no captcha", () => {
        expect.assertions(1);

        expect(userCreatingMutationWithoutCaptcha.run({ procedureProtections: [procedure({ callsMail: true })], schema: schema() })).toHaveLength(1);
    });

    it("ignores procedures that already use a captcha, or neither write users nor send mail", () => {
        expect.assertions(1);

        const procedures = [procedure({ usesCaptcha: true, writesUserTable: true }), procedure({ exportName: "b" })];

        expect(userCreatingMutationWithoutCaptcha.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });
});

describe("public_arg_uses_any", () => {
    it("flags one finding per v.any() arg", () => {
        expect.assertions(2);

        const argValidators: AdvisorArgumentValidator[] = [
            { anyArgs: ["payload", "extra"], exportName: "update", file: "update", line: 4, unboundedStringArgs: [] },
        ];
        const findings = publicArgumentUsesAny.run({ argValidators, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({ cacheKey: "public_arg_uses_any:update:update:payload", level: "WARN", name: "public_arg_uses_any" });
    });

    it("finds nothing without arg evidence", () => {
        expect.assertions(1);
        expect(publicArgumentUsesAny.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("unbounded_string_arg", () => {
    it("flags one INFO finding per unbounded string arg", () => {
        expect.assertions(2);

        const argValidators: AdvisorArgumentValidator[] = [{ anyArgs: [], exportName: "update", file: "update", line: 4, unboundedStringArgs: ["name"] }];
        const findings = unboundedStringArgument.run({ argValidators, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "unbounded_string_arg:update:update:name", level: "INFO", name: "unbounded_string_arg" });
    });
});

describe("hardcoded_secret", () => {
    it("flags one ERROR finding per secret literal, carrying only the redacted preview", () => {
        expect.assertions(3);

        const secretLiterals: AdvisorSecretLiteral[] = [{ file: "config", kind: "stripe_live_key", line: 2, preview: "sk_l…(34 chars)" }];
        const findings = hardcodedSecret.run({ schema: schema(), secretLiterals });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "hardcoded_secret:config:2:stripe_live_key", level: "ERROR", name: "hardcoded_secret" });
        expect(findings[0]?.detail).toContain("sk_l…(34 chars)");
    });

    it("produces distinct cacheKeys for two same-kind secrets on the same source line", () => {
        expect.assertions(3);

        // `const keys = [STRIPE_LIVE_A, STRIPE_LIVE_B]` — both on line 5 with
        // the same kind. Without a within-line discriminator they collapse to
        // one cacheKey and a single dismissal would silence both.
        const secretLiterals: AdvisorSecretLiteral[] = [
            { file: "config", kind: "stripe_live_key", line: 5, preview: "sk_l…(34 chars)" },
            { file: "config", kind: "stripe_live_key", line: 5, preview: "sk_l…(34 chars)" },
        ];
        const findings = hardcodedSecret.run({ schema: schema(), secretLiterals });

        expect(findings).toHaveLength(2);
        // First occurrence has no suffix; second gets `:2`.
        expect(findings[0]!.cacheKey).toBe("hardcoded_secret:config:5:stripe_live_key");
        expect(findings[1]!.cacheKey).toBe("hardcoded_secret:config:5:stripe_live_key:2");
    });

    it("finds nothing without secret evidence", () => {
        expect.assertions(1);
        expect(hardcodedSecret.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("sql_injection_risk", () => {
    it("flags one ERROR finding per interpolation", () => {
        expect.assertions(2);

        const sqlInterpolations: AdvisorSqlInterpolation[] = [{ exportName: "search", file: "search", line: 3 }];
        const findings = sqlInjectionRisk.run({ schema: schema(), sqlInterpolations });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "sql_injection_risk:search:3", level: "ERROR", name: "sql_injection_risk" });
    });
});

describe("admin_route_without_guard", () => {
    const route = (overrides: Partial<AdvisorAdminRoute> = {}): AdvisorAdminRoute => {
        return { exportName: "purge", file: "purge", method: "POST", path: "/admin/purge", usesGuard: false, ...overrides };
    };

    it("flags an unguarded admin route", () => {
        expect.assertions(2);

        const findings = adminRouteWithoutGuard.run({ adminRoutes: [route()], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "admin_route_without_guard:purge:POST:/admin/purge", level: "WARN", name: "admin_route_without_guard" });
    });

    it("ignores guarded admin routes", () => {
        expect.assertions(1);
        expect(adminRouteWithoutGuard.run({ adminRoutes: [route({ usesGuard: true })], schema: schema() })).toHaveLength(0);
    });
});
