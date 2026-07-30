import { describe, expect, it } from "vitest";

import { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH, MIN_AUTH_SECRET_LENGTH } from "../src/security-audit";

/** A token at/above the safe length, so length never trips a test that isn't about it. */
const STRONG_TOKEN = "x".repeat(MIN_ADMIN_TOKEN_LENGTH);

/** A hardened production env baseline; spread overrides to exercise one finding at a time. */
const HARDENED = { LUNORA_ADMIN_TOKEN: STRONG_TOKEN, LUNORA_WS_BEARER: "ws-secret", NODE_ENV: "production" } as const;

describe("buildSecurityAudit", () => {
    it("flags a short admin token as weak", () => {
        expect.assertions(2);

        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: "short", LUNORA_WS_BEARER: "ws-secret" }, { dev: false });
        const weak = findings.find((finding) => finding.kind === "admin-token-weak");

        expect(weak?.level).toBe("warning");
        expect(weak?.detail).toMatchObject({ length: 5, min: MIN_ADMIN_TOKEN_LENGTH });
    });

    it("does not flag a sufficiently long admin token", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: STRONG_TOKEN, LUNORA_WS_BEARER: "ws-secret" }, { dev: false });

        expect(findings.some((finding) => finding.kind === "admin-token-weak")).toBe(false);
    });

    it("flags an open WS gate as an error in production (no dev env)", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: STRONG_TOKEN }, { dev: false });
        const gate = findings.find((finding) => finding.kind === "ws-gate-open");

        expect(gate?.level).toBe("error");
    });

    it("downgrades the open WS gate to info on a dev worker and flags unredacted request args", () => {
        expect.assertions(3);

        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: STRONG_TOKEN, NODE_ENV: "development" }, { dev: true });
        const gate = findings.find((finding) => finding.kind === "ws-gate-open");
        const args = findings.find((finding) => finding.kind === "dev-args-unredacted");

        expect(gate?.level).toBe("info");
        expect(args?.level).toBe("warning");
        // dev-args-unredacted never fires off a production worker.
        expect(buildSecurityAudit({ LUNORA_ADMIN_TOKEN: STRONG_TOKEN, LUNORA_WS_BEARER: "ws" }, { dev: false }).findings).toHaveLength(0);
    });

    it("returns no findings for a fully hardened production env", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: STRONG_TOKEN, LUNORA_WS_BEARER: "ws-secret", NODE_ENV: "production" }, { dev: false });

        expect(findings).toHaveLength(0);
    });

    it("sorts findings worst-first (error before warning before info)", () => {
        expect.assertions(1);

        // Short token (warning) + open gate in prod (error) → error must lead.
        const { findings } = buildSecurityAudit({ LUNORA_ADMIN_TOKEN: "short" }, { dev: false });

        expect(findings.map((finding) => finding.level)).toStrictEqual(["error", "warning"]);
    });
});

describe("buildSecurityAudit — auth secret", () => {
    it("flags a short AUTH_SECRET as weak, carrying the length", () => {
        expect.assertions(2);

        const { findings } = buildSecurityAudit({ ...HARDENED, AUTH_SECRET: "tooshort" }, { dev: false });
        const weak = findings.find((finding) => finding.kind === "auth-secret-weak");

        expect(weak?.level).toBe("warning");
        expect(weak?.detail).toMatchObject({ length: 8, min: MIN_AUTH_SECRET_LENGTH });
    });

    it("reads BETTER_AUTH_SECRET as the fallback name", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ ...HARDENED, BETTER_AUTH_SECRET: "short" }, { dev: false });

        expect(findings.some((finding) => finding.kind === "auth-secret-weak")).toBe(true);
    });

    it("does not flag a sufficiently long auth secret", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ ...HARDENED, AUTH_SECRET: "z".repeat(MIN_AUTH_SECRET_LENGTH) }, { dev: false });

        expect(findings.some((finding) => finding.kind === "auth-secret-weak")).toBe(false);
    });
});

describe("buildSecurityAudit — CORS wildcard + credentials", () => {
    it("flags an error when a wildcard origin is paired with credentials", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit(
            { ...HARDENED, LUNORA_ALLOWED_ORIGINS: "https://app.example.com, *", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
            { dev: false },
        );

        expect(findings.find((finding) => finding.kind === "cors-wildcard-credentials")?.level).toBe("error");
    });

    it("does not flag a wildcard without credentials, or credentials without a wildcard", () => {
        expect.assertions(2);

        expect(
            buildSecurityAudit({ ...HARDENED, LUNORA_ALLOWED_ORIGINS: "*" }, { dev: false }).findings.some((f) => f.kind === "cors-wildcard-credentials"),
        ).toBe(false);
        expect(
            buildSecurityAudit(
                { ...HARDENED, LUNORA_ALLOWED_ORIGINS: "https://app.example.com", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
                { dev: false },
            ).findings.some((f) => f.kind === "cors-wildcard-credentials"),
        ).toBe(false);
    });
});

describe("buildSecurityAudit — security layer opt-outs", () => {
    it("flags disabled headers and CSRF in production", () => {
        expect.assertions(2);

        const { findings } = buildSecurityAudit({ ...HARDENED, LUNORA_SECURITY_CSRF: "false", LUNORA_SECURITY_HEADERS: "off" }, { dev: false });

        expect(findings.some((finding) => finding.kind === "security-headers-disabled")).toBe(true);
        expect(findings.some((finding) => finding.kind === "csrf-disabled")).toBe(true);
    });

    it("does not flag disabled layers on a dev worker (relaxation is expected there)", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit(
            {
                LUNORA_ADMIN_TOKEN: STRONG_TOKEN,
                LUNORA_SECURITY_CSRF: "off",
                LUNORA_SECURITY_HEADERS: "off",
                LUNORA_WS_BEARER: "ws",
                NODE_ENV: "development",
            },
            { dev: true },
        );

        expect(findings.some((finding) => finding.kind === "security-headers-disabled" || finding.kind === "csrf-disabled")).toBe(false);
    });

    it("flags insecure cookies when BETTER_AUTH_URL is plaintext http in production", () => {
        expect.assertions(2);

        expect(
            buildSecurityAudit({ ...HARDENED, BETTER_AUTH_URL: "http://app.example.com" }, { dev: false }).findings.some((f) => f.kind === "cookies-insecure"),
        ).toBe(true);
        expect(
            buildSecurityAudit({ ...HARDENED, BETTER_AUTH_URL: "https://app.example.com" }, { dev: false }).findings.some((f) => f.kind === "cookies-insecure"),
        ).toBe(false);
    });
});
