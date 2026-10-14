import type { Finding } from "@lunora/advisor";
import { describe, expect, it } from "vitest";

import { applyAcceptedFindings, unreadableAcceptance } from "../src/advisor-accept";

const finding = (overrides: Partial<Finding> & { metadata?: Record<string, unknown> }): Finding => {
    return {
        cacheKey: "k",
        categories: ["SCHEMA"],
        description: "d",
        detail: "the problem",
        facing: "INTERNAL",
        level: "ERROR",
        metadata: { exportName: "addTeamMember", file: "lunora/auth/team.ts" },
        name: "owner_field_from_args_not_auth",
        remediation: "r",
        title: "t",
        ...overrides,
    };
};

const entry = { exportName: "addTeamMember", file: "lunora/auth/team.ts", reason: "org admin gate", rule: "owner_field_from_args_not_auth" };

describe("applyAcceptedFindings", () => {
    it("demotes the one ERROR whose rule, file and export all match, with the reason in the detail", () => {
        expect.assertions(2);

        const [demoted] = applyAcceptedFindings([finding({})], [entry]);

        expect(demoted?.level).toBe("INFO");
        expect(demoted?.detail).toBe("Accepted: org admin gate. the problem");
    });

    it.each([
        ["another export", { exportName: "addMember" }],
        ["another file", { file: "lunora/auth/organization.ts" }],
        ["a helper with no export name", { exportName: undefined }],
    ])("keeps the ERROR when the finding is for %s", (_label, metadata) => {
        expect.assertions(1);

        const [kept] = applyAcceptedFindings([finding({ metadata: { ...finding({}).metadata, ...metadata } })], [entry]);

        expect(kept?.level).toBe("ERROR");
    });

    it("never accepts a finding that is not an ERROR", () => {
        expect.assertions(1);

        const [warn] = applyAcceptedFindings([finding({ level: "WARN" })], [entry]);

        expect(warn?.level).toBe("WARN");
    });

    it("warns about an entry that matches no ERROR", () => {
        expect.assertions(2);

        const result = applyAcceptedFindings([], [entry]);

        expect(result.map((advisory) => advisory.name)).toStrictEqual(["advisor_accept_unused"]);
        expect(result[0]?.level).toBe("WARN");
    });

    it("keeps the advisor_accept_invalid warning out of the matcher's path", () => {
        expect.assertions(1);

        expect(unreadableAcceptance().name).toBe("advisor_accept_invalid");
    });
});
