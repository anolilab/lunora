import type { CodegenResult } from "@lunora/codegen";
import { describe, expect, it } from "vitest";

import { blockingFindingsMessage, reportCodegenFindings } from "../src/log-badge";

const errorAdvisory = (name: string): CodegenResult["advisories"][number] => {
    return {
        cacheKey: name,
        categories: ["SCHEMA"],
        description: "d",
        detail: "the problem",
        facing: "INTERNAL",
        level: "ERROR",
        metadata: {},
        name,
        remediation: "r",
        title: "t",
    };
};

describe("blockingFindingsMessage", () => {
    it("blocks on an ERROR advisory by default", () => {
        expect.assertions(1);

        expect(blockingFindingsMessage({ advisories: [errorAdvisory("unindexed_scan")], platformDiagnostics: [] })).toContain("unindexed_scan");
    });

    it("does not block on an ERROR advisory when the strict gate is opted out", () => {
        expect.assertions(1);

        expect(
            blockingFindingsMessage({ advisories: [errorAdvisory("unindexed_scan")], platformDiagnostics: [] }, { strictAdvisories: false }),
        ).toBeUndefined();
    });
});

describe("reportCodegenFindings", () => {
    it("logs an ERROR accepted by an inline directive as a warning with its reason", () => {
        expect.assertions(2);

        const errors: string[] = [];
        const warnings: string[] = [];
        const accepted = { ...errorAdvisory("accepted_rule"), suppressed: { file: "lunora/a.ts", line: 1, reason: "single-tenant demo" } };

        reportCodegenFindings(
            { advisories: [accepted], platformDiagnostics: [] },
            { error: (message) => errors.push(message), warn: (message) => warnings.push(message) },
        );

        expect(errors).toStrictEqual([]);
        expect(warnings[0]).toContain("suppressed: single-tenant demo");
    });
});
