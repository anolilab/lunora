import { describe, expect, it } from "vitest";

import { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH } from "../src/security-audit";

/** A token at/above the safe length, so length never trips a test that isn't about it. */
const STRONG_TOKEN = "x".repeat(MIN_ADMIN_TOKEN_LENGTH);

describe("buildSecurityAudit", () => {
    it("flags a short admin token as weak", () => {
        expect.assertions(2);

        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: "short", CIRRUS_WS_BEARER: "ws-secret" });
        const weak = findings.find((finding) => finding.kind === "admin-token-weak");

        expect(weak?.level).toBe("warning");
        expect(weak?.detail).toMatchObject({ length: 5, min: MIN_ADMIN_TOKEN_LENGTH });
    });

    it("does not flag a sufficiently long admin token", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: STRONG_TOKEN, CIRRUS_WS_BEARER: "ws-secret" });

        expect(findings.some((finding) => finding.kind === "admin-token-weak")).toBe(false);
    });

    it("flags an open WS gate as an error in production (no dev env)", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: STRONG_TOKEN });
        const gate = findings.find((finding) => finding.kind === "ws-gate-open");

        expect(gate?.level).toBe("error");
    });

    it("downgrades the open WS gate to info on a dev worker and flags unredacted request args", () => {
        expect.assertions(3);

        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: STRONG_TOKEN, NODE_ENV: "development" });
        const gate = findings.find((finding) => finding.kind === "ws-gate-open");
        const args = findings.find((finding) => finding.kind === "dev-args-unredacted");

        expect(gate?.level).toBe("info");
        expect(args?.level).toBe("warning");
        // dev-args-unredacted never fires off a production worker.
        expect(buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: STRONG_TOKEN, CIRRUS_WS_BEARER: "ws" }).findings).toHaveLength(0);
    });

    it("returns no findings for a fully hardened production env", () => {
        expect.assertions(1);

        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: STRONG_TOKEN, CIRRUS_WS_BEARER: "ws-secret", NODE_ENV: "production" });

        expect(findings).toHaveLength(0);
    });

    it("sorts findings worst-first (error before warning before info)", () => {
        expect.assertions(1);

        // Short token (warning) + open gate in prod (error) → error must lead.
        const { findings } = buildSecurityAudit({ CIRRUS_ADMIN_TOKEN: "short" });

        expect(findings.map((finding) => finding.level)).toStrictEqual(["error", "warning"]);
    });
});
