import { describe, expect, it } from "vitest";

import { checkCoverage } from "../../../shared/privacy-coverage";

describe(checkCoverage, () => {
    it("passes when every owned table is covered by a dataset or excluded with a reason", () => {
        expect(
            checkCoverage(["tasks", "goals", "featureFlags"], {
                featureFlags: { excluded: "Operator configuration; contains no personal data" },
                goals: { dataset: "tasks" },
                tasks: { dataset: "tasks" },
            }),
        ).toStrictEqual([]);
    });

    it("reports a table with no classification as unclassified", () => {
        expect(checkCoverage(["tasks", "notes"], { tasks: { dataset: "tasks" } })).toStrictEqual([{ code: "unclassified", table: "notes" }]);
    });

    it("refuses an exclusion with a blank reason", () => {
        expect(checkCoverage(["flags"], { flags: { excluded: "   " } })).toStrictEqual([{ code: "excluded_without_reason", table: "flags" }]);
    });
});
