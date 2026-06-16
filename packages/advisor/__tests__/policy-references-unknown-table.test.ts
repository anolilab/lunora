import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorRlsProcedure } from "../src";
import { fromServerSchema } from "../src";
import policyReferencesUnknownTable from "../src/lints/static/policy-references-unknown-table";

const schema = () =>
    fromServerSchema(
        defineSchema({
            documents: defineTable({ ownerId: v.string(), title: v.string() }),
            messages: defineTable({ content: v.string() }),
        }),
    );

const run = (rlsProcedures?: AdvisorRlsProcedure[]) => policyReferencesUnknownTable.run({ rlsProcedures, schema: schema() });

/**
 * Build a minimal AdvisorRlsProcedure. Defaults to a public RLS procedure whose
 * policies cover the real "documents" table.
 */
const proc = (overrides: Partial<AdvisorRlsProcedure> = {}): AdvisorRlsProcedure => {
    return {
        exportName: "listDocuments",
        file: "documents",
        rlsTables: ["documents"],
        tablesRead: ["documents"],
        tablesWritten: [],
        usesRls: true,
        visibility: "public",
        ...overrides,
    };
};

describe("policy_references_unknown_table", () => {
    it("finds nothing when no rlsProcedures evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) has no policy-table evidence.
        expect(run()).toHaveLength(0);
    });

    it("finds nothing when every policy table exists in the schema", () => {
        expect.assertions(1);

        const procedures: AdvisorRlsProcedure[] = [
            proc({ rlsTables: ["documents"] }),
            proc({ exportName: "listMessages", file: "messages", rlsTables: ["messages"] }),
        ];

        expect(run(procedures)).toHaveLength(0);
    });

    it("flags a policy bound to a table that does not exist in the schema", () => {
        expect.assertions(4);

        // "document" (singular) is a typo for the real "documents" table.
        const procedures: AdvisorRlsProcedure[] = [proc({ exportName: "listDocs", rlsTables: ["document"] })];
        const findings = run(procedures);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "policy_references_unknown_table:document",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { exportName: "listDocs", file: "documents", table: "document" },
            name: "policy_references_unknown_table",
        });
        expect(findings[0]?.detail).toContain("listDocs");
        expect(findings[0]?.detail).toContain("document");
    });

    it("ignores empty-string policy tables (non-literal policies arg the feeder couldn't read)", () => {
        expect.assertions(1);

        // "" marks a policies argument the static feeder could not resolve.
        const procedures: AdvisorRlsProcedure[] = [proc({ rlsTables: ["", "documents"] })];

        expect(run(procedures)).toHaveLength(0);
    });

    it("reports an unknown table once even when many procedures reference it", () => {
        expect.assertions(2);

        const procedures: AdvisorRlsProcedure[] = [
            proc({ exportName: "a", rlsTables: ["ghost"] }),
            proc({ exportName: "b", rlsTables: ["ghost"] }),
            proc({ exportName: "c", rlsTables: ["ghost", "documents"] }),
        ];
        const findings = run(procedures);

        // Deduped by table name; the first referencing procedure is the locus.
        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ exportName: "a", table: "ghost" });
    });

    it("emits one finding per distinct unknown table", () => {
        expect.assertions(2);

        const procedures: AdvisorRlsProcedure[] = [proc({ rlsTables: ["ghost", "phantom", "documents"] })];
        const findings = run(procedures);

        expect(findings).toHaveLength(2);
        expect(findings.map((f) => f.metadata["table"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["ghost", "phantom"]);
    });
});
