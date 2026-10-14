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
