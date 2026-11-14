import { describe, expect, it } from "vitest";

import type { Finding, Lint } from "../src";
import { dedupeCacheKeys, runAdvisor } from "../src";

/** Build a minimal {@link Finding} carrying the given cacheKey. */
const finding = (cacheKey: string): Finding => {
    return {
        cacheKey,
        categories: ["SECURITY"],
        description: "d",
        detail: cacheKey,
        facing: "INTERNAL",
        level: "ERROR",
        metadata: {},
        name: "test_lint",
        remediation: "r",
        title: "t",
    };
};

describe("dedupeCacheKeys", () => {
    it("suffixes the second-and-later occurrence of a repeated cacheKey, leaving the first stable", () => {
        expect.assertions(1);

        const out = dedupeCacheKeys([finding("a:1"), finding("a:1"), finding("a:1"), finding("b:2")]);

        expect(out.map((f) => f.cacheKey)).toEqual(["a:1", "a:1:2", "a:1:3", "b:2"]);
    });

    it("leaves distinct cacheKeys untouched and preserves order", () => {
        expect.assertions(1);

        const out = dedupeCacheKeys([finding("x"), finding("y"), finding("z")]);

        expect(out.map((f) => f.cacheKey)).toEqual(["x", "y", "z"]);
    });
});

describe("runAdvisor cacheKey disambiguation", () => {
    it("disambiguates two same-line findings a lint emits with an identical cacheKey (studio would collapse them)", () => {
        expect.assertions(2);

        // A file:line-keyed lint (argument-derived sinks, sql_injection_risk, …)
        // can legitimately emit two occurrences on one physical source line. If
        // runAdvisor returned two findings with the same cacheKey the studio would
        // dedup them to one, hiding the second ERROR.
        const collidingLint: Lint = {
            categories: ["SECURITY"],
            description: "d",
            facing: "INTERNAL",
            level: "ERROR",
            name: "kv_unscoped_user_key_idor",
            remediation: "r",
            run: () => [finding("kv_unscoped_user_key_idor:handlers:12"), finding("kv_unscoped_user_key_idor:handlers:12")],
            source: "static",
            title: "t",
        };

        const findings = runAdvisor({ schema: { tables: [] } }, { lints: [collidingLint] });

        expect(findings).toHaveLength(2);
        expect(findings.map((f) => f.cacheKey)).toEqual(["kv_unscoped_user_key_idor:handlers:12", "kv_unscoped_user_key_idor:handlers:12:2"]);
    });
});

describe("runAdvisor lint isolation", () => {
    it("reports a throwing lint as a failure finding and still returns the other lints' findings", () => {
        expect.assertions(7);

        const throwingLint: Lint = {
            categories: ["SECURITY"],
            description: "d",
            facing: "INTERNAL",
            level: "ERROR",
            name: "throwing_lint",
            remediation: "r",
            run: () => {
                throw new Error("boom");
            },
            source: "static",
            title: "t",
        };
        const okLint: Lint = {
            categories: ["SECURITY"],
            description: "d",
            facing: "INTERNAL",
            level: "ERROR",
            name: "ok_lint",
            remediation: "r",
            run: () => [finding("ok:1")],
            source: "static",
            title: "t",
        };

        const findings = runAdvisor({ schema: { tables: [] } }, { lints: [throwingLint, okLint] });

        expect(findings).toHaveLength(2);
        expect(findings[0]?.name).toBe("advisor_lint_failed");
        expect(findings[0]?.level).toBe("ERROR");
        expect(findings[0]?.cacheKey).toBe("advisor_lint_failed:throwing_lint");
        expect(findings[0]?.metadata).toEqual({ lint: "throwing_lint" });
        expect(findings[0]?.detail).toContain("boom");
        expect(findings[1]?.cacheKey).toBe("ok:1");
    });

    it("gives the failure finding the throwing lint's own level, not a fixed WARN", () => {
        expect.assertions(2);

        const infoLint: Lint = {
            categories: ["SECURITY"],
            description: "d",
            facing: "INTERNAL",
            level: "INFO",
            name: "info_lint",
            remediation: "r",
            run: () => {
                throw new Error("boom");
            },
            source: "static",
            title: "t",
        };

        const findings = runAdvisor({ schema: { tables: [] } }, { lints: [infoLint] });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe("INFO");
    });
});
