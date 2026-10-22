import type { CodegenResult } from "@lunora/codegen";
import { describe, expect, it } from "vitest";

import { blockingFindingsMessage } from "../src/log-badge";

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
