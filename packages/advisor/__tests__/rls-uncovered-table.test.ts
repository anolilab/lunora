import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorRlsProcedure } from "../src";
import { fromServerSchema } from "../src";
import rlsUncoveredTable from "../src/lints/static/rls-uncovered-table";

const schema = () =>
    fromServerSchema(
        defineSchema({
            documents: defineTable({ ownerId: v.string(), title: v.string() }),
            messages: defineTable({ content: v.string() }),
        }),
    );

const run = (rlsProcedures?: AdvisorRlsProcedure[]) => rlsUncoveredTable.run({ rlsProcedures, schema: schema() });

/**
 * Build a minimal AdvisorRlsProcedure. Defaults to a public, non-RLS procedure
 * that reads the "documents" table.
 */
const proc = (overrides: Partial<AdvisorRlsProcedure> = {}): AdvisorRlsProcedure => {
    return {
        exportName: "listDocuments",
        file: "documents",
        rlsTables: [],
        tablesRead: ["documents"],
        tablesWritten: [],
        usesRls: false,
        visibility: "public",
        ...overrides,
    };
};

describe("rls_uncovered_table", () => {
    it("finds nothing when no rlsProcedures evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must flag nothing.
        expect(run()).toHaveLength(0);
    });

    it("finds nothing when there are zero policy-covered tables (no rls() used anywhere)", () => {
        expect.assertions(1);

        // No procedure uses rls() → no policyCoveredTables → nothing to flag.
        const procedures: AdvisorRlsProcedure[] = [
            proc({ tablesRead: ["documents"], usesRls: false }),
            proc({ exportName: "sendMessage", file: "messages", tablesWritten: ["messages"] }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("flags a public reader of a policy-covered table that omits .use(rls())", () => {
        expect.assertions(4);

        // "secureList" uses rls() covering "documents".
        // "leakyList" reads "documents" without rls() → should be flagged.
        const procedures: AdvisorRlsProcedure[] = [
            proc({
                exportName: "secureList",
                rlsTables: ["documents"],
                tablesRead: ["documents"],
                usesRls: true,
            }),
            proc({
                exportName: "leakyList",
                tablesRead: ["documents"],
                usesRls: false,
            }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "rls_uncovered_table:documents:leakyList:documents",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { exportName: "leakyList", file: "documents", table: "documents" },
            name: "rls_uncovered_table",
        });
        expect(findings[0]?.detail).toContain("leakyList");
        expect(findings[0]?.detail).toContain("documents");
    });

    it("does not flag a procedure that includes .use(rls()) in its chain", () => {
        expect.assertions(1);

        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "secureList", rlsTables: ["documents"], usesRls: true }),
            proc({ exportName: "anotherSecure", rlsTables: ["documents"], tablesRead: ["documents"], usesRls: true }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("does not flag a procedure reading a table not covered by any rls() policy", () => {
        expect.assertions(1);

        // "documents" is policy-covered; "messages" is not.
        // A procedure reading only "messages" without rls() should be silent.
        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "secureList", rlsTables: ["documents"], usesRls: true }),
            proc({
                exportName: "listMessages",
                file: "messages",
                tablesRead: ["messages"],
                tablesWritten: [],
                usesRls: false,
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("flags a writer (insert path) of a policy-covered table without rls()", () => {
        expect.assertions(2);

        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "secureList", rlsTables: ["documents"], usesRls: true }),
            proc({
                exportName: "unsafeCreate",
                tablesRead: [],
                tablesWritten: ["documents"],
                usesRls: false,
            }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "rls_uncovered_table:documents:unsafeCreate:documents",
            metadata: { exportName: "unsafeCreate", file: "documents", table: "documents" },
            name: "rls_uncovered_table",
        });
    });

    it("does not flag an internal procedure reading a policy-covered table", () => {
        expect.assertions(1);

        // internalQuery procedures are intentional server-side helpers that
        // legitimately bypass the public RLS gate. They must not be flagged.
        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "secureList", rlsTables: ["documents"], usesRls: true }),
            proc({
                exportName: "adminList",
                tablesRead: ["documents"],
                usesRls: false,
                visibility: "internal",
            }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("emits one finding per (procedure, table) for multi-table touches", () => {
        expect.assertions(3);

        // Both "documents" and "messages" are policy-covered.
        // One procedure reads both without rls() → 2 findings.
        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "secureDocs", rlsTables: ["documents"], usesRls: true }),
            proc({ exportName: "secureMessages", file: "messages", rlsTables: ["messages"], tablesRead: ["messages"], usesRls: true }),
            proc({
                exportName: "leakyDashboard",
                file: "dashboard",
                tablesRead: ["documents", "messages"],
                usesRls: false,
            }),
        ];
        const findings = run(procedures);

        expect(findings).toHaveLength(2);
        expect(findings.map((f) => f.metadata["table"])).toContain("documents");
        expect(findings.map((f) => f.metadata["table"])).toContain("messages");
    });
});
