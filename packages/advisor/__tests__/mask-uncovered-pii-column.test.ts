import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import type { AdvisorMaskProcedure } from "../src";
import { fromServerSchema } from "../src";
import maskUncoveredPiiColumn from "../src/lints/static/mask-uncovered-pii-column";

const schema = () =>
    fromServerSchema(
        defineSchema({
            messages: defineTable({ content: v.string() }),
            users: defineTable({ email: v.string(), name: v.string(), phone: v.string() }),
        }),
    );

const run = (maskProcedures?: AdvisorMaskProcedure[]) => maskUncoveredPiiColumn.run({ maskProcedures, schema: schema() });

/**
 * Build a minimal AdvisorMaskProcedure. Defaults to a public, non-masking
 * procedure that reads the "users" table.
 */
const proc = (overrides: Partial<AdvisorMaskProcedure> = {}): AdvisorMaskProcedure => {
    return {
        exportName: "listUsers",
        file: "listUsers",
        maskColumns: [],
        tablesRead: ["users"],
        tablesWritten: [],
        usesMask: false,
        visibility: "public",
        ...overrides,
    };
};

describe("mask_uncovered_pii_column", () => {
    it("finds nothing when no maskProcedures evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must flag nothing.
        expect(run()).toHaveLength(0);
    });

    it("finds nothing when no procedure masks any column", () => {
        expect.assertions(1);

        // No procedure uses mask() → no maskedColumnsByTable → nothing to flag.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ tablesRead: ["users"], usesMask: false }),
            proc({ exportName: "listMessages", file: "listMessages", tablesRead: ["messages"] }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("flags a public reader of a mask-covered table that omits .use(mask())", () => {
        expect.assertions(5);

        // "safeList" masks users.email; "leakyList" reads users without mask().
        const procedures: AdvisorMaskProcedure[] = [
            proc({
                exportName: "safeList",
                maskColumns: [{ column: "email", table: "users" }],
                tablesRead: ["users"],
                usesMask: true,
            }),
            proc({
                exportName: "leakyList",
                tablesRead: ["users"],
                usesMask: false,
            }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "mask_uncovered_pii_column:listUsers:leakyList:users",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { columns: ["email"], exportName: "leakyList", file: "listUsers", table: "users" },
            name: "mask_uncovered_pii_column",
        });
        expect(findings[0]?.detail).toContain("leakyList");
        expect(findings[0]?.detail).toContain("email");
        expect(findings[0]?.detail).toContain("users");
    });

    it("does not flag a procedure that includes .use(mask()) in its chain", () => {
        expect.assertions(1);

        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "safeList", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({
                exportName: "anotherSafe",
                maskColumns: [{ column: "email", table: "users" }],
                tablesRead: ["users"],
                usesMask: true,
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("does not flag a procedure reading a table no procedure masks", () => {
        expect.assertions(1);

        // "users" is mask-covered; "messages" is not.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "safeList", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({
                exportName: "listMessages",
                file: "listMessages",
                tablesRead: ["messages"],
                usesMask: false,
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("does not flag a write-only procedure of a mask-covered table (masking is read-path only)", () => {
        expect.assertions(1);

        // A procedure that only writes the table never returns its rows, so
        // masking does not apply — writes must not trigger the lint.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "safeList", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({
                exportName: "createUser",
                tablesRead: [],
                tablesWritten: ["users"],
                usesMask: false,
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("does not flag an internal procedure reading a mask-covered table", () => {
        expect.assertions(1);

        // internal* procedures intentionally bypass masking; never flagged.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "safeList", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({
                exportName: "adminExport",
                tablesRead: ["users"],
                usesMask: false,
                visibility: "internal",
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("lists every masked column app-wide in the finding, sorted", () => {
        expect.assertions(2);

        // Two procedures mask different columns of the same table; the finding
        // for an uncovered reader names both, sorted.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "maskPhone", maskColumns: [{ column: "phone", table: "users" }], usesMask: true }),
            proc({ exportName: "maskEmail", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({ exportName: "leakyList", tablesRead: ["users"], usesMask: false }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata["columns"]).toStrictEqual(["email", "phone"]);
    });

    it("emits one finding per (procedure, table) for multi-table touches", () => {
        expect.assertions(3);

        // Both "users" and "messages" carry a masked column; one procedure reads
        // both without mask() → 2 findings.
        const procedures: AdvisorMaskProcedure[] = [
            proc({ exportName: "maskUsers", maskColumns: [{ column: "email", table: "users" }], usesMask: true }),
            proc({
                exportName: "maskMessages",
                file: "maskMessages",
                maskColumns: [{ column: "content", table: "messages" }],
                tablesRead: ["messages"],
                usesMask: true,
            }),
            proc({
                exportName: "leakyDashboard",
                file: "dashboard",
                tablesRead: ["users", "messages"],
                usesMask: false,
            }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.metadata["table"])).toContain("users");
        expect(findings.map((finding) => finding.metadata["table"])).toContain("messages");
    });
});
