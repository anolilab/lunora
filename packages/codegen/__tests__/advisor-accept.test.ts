import type { Finding } from "@lunora/advisor";
import { describe, expect, it } from "vitest";

import type { AcceptedFinding } from "../src/advisor-accept";
import { applyAcceptedFindings, isAcceptanceOutcome, unreadableAcceptance } from "../src/advisor-accept";

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

const entry: AcceptedFinding = {
    exportName: "addTeamMember",
    file: "lunora/auth/team.ts",
    level: "ERROR",
    reason: "org admin gate",
    rule: "owner_field_from_args_not_auth",
};

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

    it("demotes a reviewed WARN to INFO with the reason, so it no longer reads as an open item", () => {
        expect.assertions(3);

        const [reviewed] = applyAcceptedFindings([finding({ level: "WARN" })], [{ ...entry, level: "WARN" }]);

        expect(reviewed?.level).toBe("INFO");
        expect(reviewed?.detail).toBe("Accepted: org admin gate. the problem");
        expect(reviewed?.metadata["accepted"]).toBe("org admin gate");
    });

    it("keeps a reviewed INFO at INFO and marks it accepted, with no unused-entry warning", () => {
        expect.assertions(3);

        const result = applyAcceptedFindings([finding({ level: "INFO" })], [{ ...entry, level: "INFO" }]);

        expect(result.map((advisory) => advisory.name)).toStrictEqual(["owner_field_from_args_not_auth"]);
        expect(result[0]?.level).toBe("INFO");
        expect(result[0]?.metadata["accepted"]).toBe("org admin gate");
    });

    // A schema finding carries its table, not an export, so an entry names the table it accepts.
    it("accepts a schema finding that names a table rather than an export", () => {
        expect.assertions(3);

        const tableEntry = {
            exportName: "users",
            file: "lunora/schema.ts",
            level: "INFO" as const,
            reason: "seeded by a migration",
            rule: "table_without_insert",
        };
        const result = applyAcceptedFindings(
            [finding({ name: "table_without_insert", level: "INFO", metadata: { file: "lunora/schema.ts", table: "users" } })],
            [tableEntry],
        );

        expect(result.map((advisory) => advisory.name)).toStrictEqual(["table_without_insert"]);
        expect(result[0]?.metadata["accepted"]).toBe("seeded by a migration");
        expect(result[0]?.level).toBe("INFO");
    });

    // One procedure can carry the same finding for several tables, so accepting one table must not accept the others.
    it("accepts only the table an entry names when a procedure has the same finding for several tables", () => {
        expect.assertions(2);

        const tableFinding = (table: string): Finding =>
            finding({ level: "WARN", metadata: { exportName: "listMembers", file: "lunora/team.ts", table }, name: "rls_uncovered_table" });
        const result = applyAcceptedFindings(
            [tableFinding("members"), tableFinding("invites")],
            [{ exportName: "listMembers", file: "lunora/team.ts", level: "WARN", reason: "members are public", rule: "rls_uncovered_table", table: "members" }],
        );

        expect(result.map((advisory) => [advisory.metadata["table"], advisory.level])).toStrictEqual([
            ["members", "INFO"],
            ["invites", "WARN"],
        ]);
        expect(result.some((advisory) => advisory.name === "advisor_accept_unused")).toBe(false);
    });

    // A procedure that starts reaching a second table must not have it accepted by an entry written for the first.
    it("accepts none of a procedure's table findings for an entry without a table once there is more than one", () => {
        expect.assertions(3);

        const tableFinding = (table: string): Finding =>
            finding({ level: "WARN", metadata: { exportName: "listMembers", file: "lunora/team.ts", table }, name: "rls_uncovered_table" });
        const untabled: AcceptedFinding = {
            exportName: "listMembers",
            file: "lunora/team.ts",
            level: "WARN",
            reason: "members are public",
            rule: "rls_uncovered_table",
        };

        const [single] = applyAcceptedFindings([tableFinding("members")], [untabled]);
        const several = applyAcceptedFindings([tableFinding("members"), tableFinding("invites")], [untabled]);

        expect(single?.level).toBe("INFO");
        expect(several.map((advisory) => advisory.level)).toStrictEqual(["WARN", "WARN", "WARN"]);
        expect(several[2]?.remediation).toContain("`table`");
    });

    // A weak hash reports one finding per column, so two hashed columns of one table are still one table.
    it("accepts every finding about one table for an entry without a table, one per column", () => {
        expect.assertions(2);

        const columnFinding = (column: string, table: string): Finding =>
            finding({ level: "WARN", metadata: { column, exportName: "listUsers", file: "lunora/users.ts", table }, name: "mask_weak_hash_strategy_on_pii" });
        const untabled: AcceptedFinding = {
            exportName: "listUsers",
            file: "lunora/users.ts",
            level: "WARN",
            reason: "hashes are salted",
            rule: "mask_weak_hash_strategy_on_pii",
        };

        const result = applyAcceptedFindings([columnFinding("email", "users"), columnFinding("phone", "users")], [untabled]);
        const unknownTable = applyAcceptedFindings([columnFinding("email", "")], [untabled]);

        expect(result.map((advisory) => advisory.level)).toStrictEqual(["INFO", "INFO"]);
        expect(unknownTable.map((advisory) => advisory.level)).toStrictEqual(["INFO"]);
    });

    it("does not match an entry that names a table to a finding about no table", () => {
        expect.assertions(1);

        const [kept] = applyAcceptedFindings([finding({})], [{ ...entry, table: "members" }]);

        expect(kept?.level).toBe("ERROR");
    });

    // The floor keeps an accepted ERROR, but not an accepted WARN or INFO, so an acceptance cannot bring back a finding the floor hides.
    it("keeps the floor's exemption for an accepted ERROR only", () => {
        expect.assertions(3);

        const [acceptedError] = applyAcceptedFindings([finding({})], [entry]);
        const [acceptedWarn] = applyAcceptedFindings([finding({ level: "WARN" })], [{ ...entry, level: "WARN" }]);

        expect(isAcceptanceOutcome(acceptedError as Finding)).toBe(true);
        expect(isAcceptanceOutcome(acceptedWarn as Finding)).toBe(false);
        expect(acceptedWarn?.metadata["acceptedFrom"]).toBe("WARN");
    });

    // An acceptance written for a WARN must not silently cover the same export once it is an ERROR.
    it("keeps an ERROR that an entry written for a WARN would otherwise cover", () => {
        expect.assertions(3);

        const result = applyAcceptedFindings([finding({})], [{ ...entry, level: "WARN" }]);

        expect(result.find((advisory) => advisory.name === "owner_field_from_args_not_auth")?.level).toBe("ERROR");
        expect(result.find((advisory) => advisory.name === "advisor_accept_unused")?.level).toBe("WARN");
        expect(result.find((advisory) => advisory.name === "advisor_accept_unused")?.detail).toContain("No WARN `owner_field_from_args_not_auth`");
    });

    it("warns about an entry that matches no finding at any level", () => {
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
