import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type {
    AdvisorAdminRoute,
    AdvisorArgumentDerivedFetch,
    AdvisorArgumentValidator,
    AdvisorConfigCall,
    AdvisorProcedureProtection,
    AdvisorSecretLiteral,
    AdvisorSqlInterpolation,
    AdvisorWranglerVariable,
} from "../src";
import { fromServerSchema } from "../src";
import actionFetchSsrf from "../src/lints/static/action-fetch-ssrf";
import adminRouteWithoutGuard from "../src/lints/static/admin-route-without-guard";
import aiUnboundedGenerationPublic from "../src/lints/static/ai-unbounded-generation-public";
import allowUnauthenticatedShardAccessEnabled from "../src/lints/static/allow-unauthenticated-shard-access-enabled";
import browserAllowPrivateTargets from "../src/lints/static/browser-allow-private-targets";
import hardcodedSecret from "../src/lints/static/hardcoded-secret";
import insertManyUnsafeUserData from "../src/lints/static/insert-many-unsafe-user-data";
import mailInboundDispatchWithoutVerify from "../src/lints/static/mail-inbound-dispatch-without-verify";
import paymentCreateWithoutAuthorize from "../src/lints/static/payment-create-without-authorize";
import plaintextSecretInWranglerVariables from "../src/lints/static/plaintext-secret-in-wrangler-variables";
import privilegedFanoutFromPublicProcedure from "../src/lints/static/privileged-fanout-from-public-procedure";
import publicArgumentUsesAny from "../src/lints/static/public-argument-uses-any";
import publicMutationWithoutRatelimit from "../src/lints/static/public-mutation-without-ratelimit";
import ratelimitDefaultMemoryStore from "../src/lints/static/ratelimit-default-memory-store";
import signupMutationWithoutDisposableGating from "../src/lints/static/signup-mutation-without-disposable-gating";
import sqlInjectionRisk from "../src/lints/static/sql-injection-risk";
import unboundedStringArgument from "../src/lints/static/unbounded-string-argument";
import userCreatingMutationWithoutCaptcha from "../src/lints/static/user-creating-mutation-without-captcha";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

/** A fully-unprotected public procedure; spread overrides to vary one fact at a time. */
const procedure = (overrides: Partial<AdvisorProcedureProtection> = {}): AdvisorProcedureProtection => {
    return {
        callsMail: false,
        exportName: "signUp",
        fanOut: false,
        file: "signup",
        kind: "mutation",
        unboundedAiGeneration: false,
        usesCaptcha: false,
        usesEmailGate: false,
        usesInsertManyUnsafe: false,
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

    it("does not call a benign write auth-sensitive on a substring match", () => {
        expect.assertions(2);

        // "reset" inside `updatePresets`, "subscribe" inside `unsubscribeAll`.
        const procedures = [procedure({ exportName: "updatePresets" }), procedure({ exportName: "unsubscribeAll" })];
        const findings = publicMutationWithoutRatelimit.run({ procedureProtections: procedures, schema: schema() });

        expect(findings.map((finding) => finding.metadata?.sensitive)).toStrictEqual([false, false]);
        expect(findings.every((finding) => !finding.detail.includes("auth/abuse-sensitive"))).toBe(true);
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

    it("stays fail-closed when the feeder couldn't read the handler body (writesUserTable/callsMail undefined)", () => {
        expect.assertions(2);

        // A genuinely cross-file handler reports `undefined`, not `false` — an
        // accidental fail-open here is worse than the lint over-firing.
        const procedures = [procedure({ analyzableBody: false, callsMail: undefined, writesUserTable: undefined })];
        const findings = userCreatingMutationWithoutCaptcha.run({ procedureProtections: procedures, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain("its handler body could not be read");
    });

    it("does not claim the handler body was unreadable for a partial payload (one fact proven false, the other undefined)", () => {
        expect.assertions(2);

        // `writesUserTable` is proven `false` here — the handler body WAS read
        // for that fact, so the fallback must not blame an unreadable body for
        // the still-undefined `callsMail`.
        const procedures = [procedure({ analyzableBody: true, callsMail: undefined, writesUserTable: false })];
        const findings = userCreatingMutationWithoutCaptcha.run({ procedureProtections: procedures, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).not.toContain("its handler body could not be read");
    });
});

describe("signup_mutation_without_disposable_gating", () => {
    it("flags a user-table write with no email gate", () => {
        expect.assertions(2);

        const findings = signupMutationWithoutDisposableGating.run({ procedureProtections: [procedure({ writesUserTable: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "signup_mutation_without_disposable_gating:signup:signUp", metadata: { writesUserTable: true } });
    });

    it("ignores a procedure that already uses the email gate", () => {
        expect.assertions(1);

        const procedures = [procedure({ usesEmailGate: true, writesUserTable: true })];

        expect(signupMutationWithoutDisposableGating.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });

    it("ignores a user-table write that declares no email argument", () => {
        expect.assertions(1);

        // A B2B membership write (`members.add(userId, role)`) matches the
        // user-table pattern but has no address to gate, so the lint is
        // unactionable and must stay quiet.
        const procedures = [procedure({ hasEmailArg: false, writesUserTable: true })];

        expect(signupMutationWithoutDisposableGating.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });

    it("still flags when the feeder reports no email evidence at all", () => {
        expect.assertions(1);

        // `hasEmailArg` absent (an older feeder) must not clear the finding —
        // the lint is fail-closed on unknown.
        const procedures = [procedure({ hasEmailArg: undefined, writesUserTable: true })];

        expect(signupMutationWithoutDisposableGating.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(1);
    });

    it("ignores a procedure that writes no user table, and internal procedures", () => {
        expect.assertions(2);

        expect(signupMutationWithoutDisposableGating.run({ procedureProtections: [procedure()], schema: schema() })).toHaveLength(0);
        expect(
            signupMutationWithoutDisposableGating.run({
                procedureProtections: [procedure({ visibility: "internal", writesUserTable: true })],
                schema: schema(),
            }),
        ).toHaveLength(0);
    });

    it("still flags when the feeder couldn't read the handler body (writesUserTable undefined)", () => {
        expect.assertions(1);

        // A genuinely cross-file handler reports `undefined`, not `false` — an
        // accidental fail-open here is worse than the lint over-firing.
        const procedures = [procedure({ writesUserTable: undefined })];

        expect(signupMutationWithoutDisposableGating.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(1);
    });

    it("flags nothing when the codegen feeder supplies no protection evidence", () => {
        expect.assertions(1);

        expect(signupMutationWithoutDisposableGating.run({ schema: schema() })).toHaveLength(0);
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
    it("recommends an enforced bound, never metadata", () => {
        expect.assertions(2);

        // `.meta({ maxLength })` publishes a cap the parser never enforces; the
        // remediation once recommended exactly that, and ~90 call sites followed it.
        expect(unboundedStringArgument.remediation).toMatch(/^Add an enforced max-length bound with `\.max\(n\)`/u);
        expect(unboundedStringArgument.remediation).toContain("`.meta({ maxLength })` only documents a cap — the parser does not enforce it");
    });

    it("flags one INFO finding per unbounded string arg", () => {
        expect.assertions(2);

        const argValidators: AdvisorArgumentValidator[] = [{ anyArgs: [], exportName: "update", file: "update", line: 4, unboundedStringArgs: ["name"] }];
        const findings = unboundedStringArgument.run({ argValidators, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "unbounded_string_arg:update:update:name", level: "INFO", name: "unbounded_string_arg" });
    });

    it("flags nothing when args are bounded or absent", () => {
        expect.assertions(2);

        expect(unboundedStringArgument.run({ schema: schema() })).toHaveLength(0);
        expect(
            unboundedStringArgument.run({
                argValidators: [{ anyArgs: [], exportName: "update", file: "update", line: 4, unboundedStringArgs: [] }],
                schema: schema(),
            }),
        ).toHaveLength(0);
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

describe("plaintext_secret_in_wrangler_vars", () => {
    it("flags one ERROR finding per wrangler var, carrying only the redacted preview", () => {
        expect.assertions(3);

        const wranglerVariables: AdvisorWranglerVariable[] = [
            { file: "wrangler.jsonc", key: "STRIPE_SECRET_KEY", kind: "stripe_live_key", preview: "sk_l…(34 chars)" },
        ];
        const findings = plaintextSecretInWranglerVariables.run({ schema: schema(), wranglerVariables });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
            cacheKey: "plaintext_secret_in_wrangler_vars:wrangler.jsonc:STRIPE_SECRET_KEY",
            level: "ERROR",
            name: "plaintext_secret_in_wrangler_vars",
        });
        expect(findings[0]?.detail).toContain("sk_l…(34 chars)");
    });

    it("produces distinct cacheKeys for duplicate evidence rows for the same key", () => {
        expect.assertions(3);

        const wranglerVariables: AdvisorWranglerVariable[] = [
            { file: "wrangler.jsonc", key: "API_TOKEN", kind: "secret_named_var", preview: "abcd…(40 chars)" },
            { file: "wrangler.jsonc", key: "API_TOKEN", kind: "secret_named_var", preview: "abcd…(40 chars)" },
        ];
        const findings = plaintextSecretInWranglerVariables.run({ schema: schema(), wranglerVariables });

        expect(findings).toHaveLength(2);
        // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
        expect(findings[0]!.cacheKey).toBe("plaintext_secret_in_wrangler_vars:wrangler.jsonc:API_TOKEN");
        // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
        expect(findings[1]!.cacheKey).toBe("plaintext_secret_in_wrangler_vars:wrangler.jsonc:API_TOKEN:2");
    });

    it("finds nothing without wrangler-var evidence", () => {
        expect.assertions(1);
        expect(plaintextSecretInWranglerVariables.run({ schema: schema() })).toHaveLength(0);
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

    it("flags nothing without interpolation evidence", () => {
        expect.assertions(2);

        expect(sqlInjectionRisk.run({ schema: schema() })).toHaveLength(0);
        expect(sqlInjectionRisk.run({ schema: schema(), sqlInterpolations: [] })).toHaveLength(0);
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

/** A readable config-object call; spread overrides to vary one fact at a time. */
const configCall = (overrides: Partial<AdvisorConfigCall> = {}): AdvisorConfigCall => {
    return { analyzable: true, callee: "createPayment", file: "billing", line: 12, presentKeys: [], trueKeys: [], ...overrides };
};

describe("payment_create_without_authorize", () => {
    it("flags a createPayment with no authorize key", () => {
        expect.assertions(2);

        const findings = paymentCreateWithoutAuthorize.run({ configCalls: [configCall()], schema: schema() });

        expect(findings).toHaveLength(1);

        expect(findings[0]).toMatchObject({
            // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
            cacheKey: "payment_create_without_authorize:billing:12",
            level: "ERROR",
            name: "payment_create_without_authorize",
        });
    });

    it("ignores an authorized createPayment, an opaque config, and other callees", () => {
        expect.assertions(1);

        const calls = [configCall({ presentKeys: ["authorize"] }), configCall({ analyzable: false }), configCall({ callee: "createBrowser" })];

        expect(paymentCreateWithoutAuthorize.run({ configCalls: calls, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing without config-call evidence", () => {
        expect.assertions(1);
        expect(paymentCreateWithoutAuthorize.run({ schema: schema() })).toHaveLength(0);
    });
});

// eslint-disable-next-line no-secrets/no-secrets -- lint rule id in a describe label, not a credential
describe("mail_inbound_dispatch_without_verify", () => {
    it("flags an inbound handler with no verify key", () => {
        expect.assertions(2);

        const findings = mailInboundDispatchWithoutVerify.run({
            configCalls: [configCall({ callee: "createInboundEmailHandler", file: "email", line: 3 })],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);

        expect(findings[0]).toMatchObject({
            // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
            cacheKey: "mail_inbound_dispatch_without_verify:email:3",
            level: "ERROR",
            // eslint-disable-next-line no-secrets/no-secrets -- an advisor rule id, not a secret
            name: "mail_inbound_dispatch_without_verify",
        });
    });

    it("ignores a handler that declares a verify hook", () => {
        expect.assertions(1);

        const calls = [configCall({ callee: "createInboundEmailHandler", presentKeys: ["parse", "verify"] })];

        expect(mailInboundDispatchWithoutVerify.run({ configCalls: calls, schema: schema() })).toHaveLength(0);
    });
});

describe("ratelimit_default_memory_store", () => {
    it("flags a RateLimiter with no store key", () => {
        expect.assertions(2);

        const findings = ratelimitDefaultMemoryStore.run({ configCalls: [configCall({ callee: "RateLimiter", file: "limits", line: 8 })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "ratelimit_default_memory_store:limits:8", level: "WARN", name: "ratelimit_default_memory_store" });
    });

    it("ignores a RateLimiter with an explicit store", () => {
        expect.assertions(1);

        const calls = [configCall({ callee: "RateLimiter", presentKeys: ["store"] })];

        expect(ratelimitDefaultMemoryStore.run({ configCalls: calls, schema: schema() })).toHaveLength(0);
    });
});

describe("browser_allow_private_targets", () => {
    it("flags a createBrowser that sets allowPrivateTargets: true", () => {
        expect.assertions(2);

        const calls = [
            configCall({ callee: "createBrowser", file: "scrape", line: 5, presentKeys: ["allowPrivateTargets"], trueKeys: ["allowPrivateTargets"] }),
        ];
        const findings = browserAllowPrivateTargets.run({ configCalls: calls, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "browser_allow_private_targets:scrape:5", level: "ERROR", name: "browser_allow_private_targets" });
    });

    it("ignores a createBrowser that only names the key without setting it true", () => {
        expect.assertions(1);

        const calls = [configCall({ callee: "createBrowser", presentKeys: ["allowPrivateTargets"], trueKeys: [] })];

        expect(browserAllowPrivateTargets.run({ configCalls: calls, schema: schema() })).toHaveLength(0);
    });
});

describe("allow_unauthenticated_shard_access_enabled", () => {
    it("flags an .extend() call that sets allowUnauthenticatedShardAccess: true on an RLS-gapped schema", () => {
        expect.assertions(2);

        // The default `schema()` fixture never calls `.rls("required")`, so it
        // already has an RLS gap.
        const calls = [
            configCall({
                callee: "extend",
                file: "server",
                line: 6,
                presentKeys: ["allowUnauthenticatedShardAccess"],
                trueKeys: ["allowUnauthenticatedShardAccess"],
            }),
        ];
        const findings = allowUnauthenticatedShardAccessEnabled.run({ configCalls: calls, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "allow_unauthenticated_shard_access_enabled:server:6",
            level: "WARN",
            name: "allow_unauthenticated_shard_access_enabled",
        });
    });

    it("ignores the same .extend() call when the schema has no RLS gap", () => {
        expect.assertions(1);

        const rlsRequiredSchema = fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }).rls("required"));
        const calls = [configCall({ callee: "extend", presentKeys: ["allowUnauthenticatedShardAccess"], trueKeys: ["allowUnauthenticatedShardAccess"] })];

        expect(allowUnauthenticatedShardAccessEnabled.run({ configCalls: calls, schema: rlsRequiredSchema })).toHaveLength(0);
    });

    it('flags when the schema is .rls("required") but still has a .public() table', () => {
        expect.assertions(1);

        const gapSchema = fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }).public() }).rls("required"));
        const calls = [configCall({ callee: "extend", presentKeys: ["allowUnauthenticatedShardAccess"], trueKeys: ["allowUnauthenticatedShardAccess"] })];

        expect(allowUnauthenticatedShardAccessEnabled.run({ configCalls: calls, schema: gapSchema })).toHaveLength(1);
    });

    // The `lunora()` Vite-plugin callee is the ONLY place a class-A app (the
    // default Vite path — sveltekit / astro / react-router / tanstack-start) can
    // set the flag, since it has no worker entry to `.extend()` from. Its feeder
    // row keeps the config's file extension (`discover/config-calls.ts`'s
    // `viteConfigCalls`), unlike the `lunora/`-relative paths.
    it("flags a lunora() Vite-plugin call that sets allowUnauthenticatedShardAccess: true", () => {
        expect.assertions(3);

        const calls = [
            configCall({
                callee: "lunora",
                file: "vite.config.ts",
                line: 18,
                presentKeys: ["allowUnauthenticatedShardAccess"],
                trueKeys: ["allowUnauthenticatedShardAccess"],
            }),
        ];
        const findings = allowUnauthenticatedShardAccessEnabled.run({ configCalls: calls, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "allow_unauthenticated_shard_access_enabled:vite.config.ts:18",
            level: "WARN",
            metadata: { callee: "lunora" },
        });
        expect(findings[0]?.detail).toContain("`lunora(...)` in vite.config.ts:18");
    });

    it("ignores an .extend() call that only names the key without setting it true, an opaque config, and other callees", () => {
        expect.assertions(1);

        const calls = [
            configCall({ callee: "extend", presentKeys: ["allowUnauthenticatedShardAccess"], trueKeys: [] }),
            configCall({ analyzable: false, callee: "extend" }),
            configCall({ callee: "createBrowser", presentKeys: ["allowUnauthenticatedShardAccess"], trueKeys: ["allowUnauthenticatedShardAccess"] }),
        ];

        expect(allowUnauthenticatedShardAccessEnabled.run({ configCalls: calls, schema: schema() })).toHaveLength(0);
    });

    it("finds nothing without config-call evidence", () => {
        expect.assertions(1);
        expect(allowUnauthenticatedShardAccessEnabled.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("privileged_fanout_from_public_procedure", () => {
    it("flags a public procedure that fans out with no rate limit", () => {
        expect.assertions(2);

        const findings = privilegedFanoutFromPublicProcedure.run({
            procedureProtections: [procedure({ exportName: "enqueue", fanOut: true })],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "privileged_fanout_from_public_procedure:signup:enqueue",
            level: "WARN",
            name: "privileged_fanout_from_public_procedure",
        });
    });

    it("ignores rate-limited, internal, and non-fan-out procedures", () => {
        expect.assertions(1);

        const procedures = [
            procedure({ fanOut: true, usesRateLimit: true }),
            procedure({ exportName: "b", fanOut: true, visibility: "internal" }),
            procedure({ exportName: "c" }),
        ];

        expect(privilegedFanoutFromPublicProcedure.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });

    it("stays fail-closed when the feeder couldn't read the handler body (fanOut undefined)", () => {
        expect.assertions(1);

        const procedures = [procedure({ exportName: "enqueue", fanOut: undefined })];

        expect(privilegedFanoutFromPublicProcedure.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(1);
    });
});

describe("insert_many_unsafe_user_data", () => {
    it("flags a public procedure using insertManyUnsafe", () => {
        expect.assertions(2);

        const findings = insertManyUnsafeUserData.run({
            procedureProtections: [procedure({ exportName: "importRows", usesInsertManyUnsafe: true })],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "insert_many_unsafe_user_data:signup:importRows", level: "WARN", name: "insert_many_unsafe_user_data" });
    });

    it("ignores internal procedures and public procedures that don't use the unsafe insert", () => {
        expect.assertions(1);

        const procedures = [procedure({ exportName: "a", usesInsertManyUnsafe: true, visibility: "internal" }), procedure({ exportName: "b" })];

        expect(insertManyUnsafeUserData.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });

    it("stays fail-closed when the feeder couldn't read the handler body (usesInsertManyUnsafe undefined)", () => {
        expect.assertions(1);

        const procedures = [procedure({ exportName: "importRows", usesInsertManyUnsafe: undefined })];

        expect(insertManyUnsafeUserData.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(1);
    });
});

describe("ai_unbounded_generation_public", () => {
    it("flags a public procedure running an unbounded AI generation", () => {
        expect.assertions(2);

        const findings = aiUnboundedGenerationPublic.run({
            procedureProtections: [procedure({ exportName: "summarize", unboundedAiGeneration: true })],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "ai_unbounded_generation_public:signup:summarize",
            level: "WARN",
            name: "ai_unbounded_generation_public",
        });
    });

    it("ignores internal procedures and public procedures with a bounded generation", () => {
        expect.assertions(1);

        const procedures = [procedure({ exportName: "a", unboundedAiGeneration: true, visibility: "internal" }), procedure({ exportName: "b" })];

        expect(aiUnboundedGenerationPublic.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(0);
    });

    it("stays fail-closed when the feeder couldn't read the handler body (unboundedAiGeneration undefined)", () => {
        expect.assertions(1);

        const procedures = [procedure({ exportName: "summarize", unboundedAiGeneration: undefined })];

        expect(aiUnboundedGenerationPublic.run({ procedureProtections: procedures, schema: schema() })).toHaveLength(1);
    });
});

describe("action_fetch_ssrf", () => {
    it("flags one ERROR finding per arg-derived ctx.fetch", () => {
        expect.assertions(2);

        const argumentDerivedFetches: AdvisorArgumentDerivedFetch[] = [{ exportName: "proxyImage", file: "proxyImage", line: 7 }];
        const findings = actionFetchSsrf.run({ argumentDerivedFetches, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "action_fetch_ssrf:proxyImage:7", level: "ERROR", name: "action_fetch_ssrf" });
    });

    it("finds nothing when the feeder supplies no fetch evidence", () => {
        expect.assertions(2);

        expect(actionFetchSsrf.run({ schema: schema() })).toHaveLength(0);
        expect(actionFetchSsrf.run({ argumentDerivedFetches: [], schema: schema() })).toHaveLength(0);
    });
});
