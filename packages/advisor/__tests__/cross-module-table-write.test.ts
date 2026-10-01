import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorInsertWrite, LintContext } from "../src";
import { fromServerSchema } from "../src";
import crossModuleTableWrite from "../src/lints/static/cross-module-table-write";

const schema = () => fromServerSchema(defineSchema({ invoices: defineTable({ total: v.number() }), users: defineTable({ name: v.string() }) }));

const context = (parts: Partial<LintContext>): LintContext => {
    return { schema: schema(), ...parts };
};

const MODULES = [
    { name: "billing", tables: ["invoices"] },
    { name: "accounts", tables: [] },
];

const insert = (file: string, table = "invoices"): AdvisorInsertWrite => {
    return { exportName: "create", file, line: 3, table };
};

describe("cross_module_table_write", () => {
    it("finds nothing without modules or insert evidence", () => {
        expect.assertions(2);

        expect(crossModuleTableWrite.run(context({ inserts: [insert("accounts/signup")] }))).toHaveLength(0);
        expect(crossModuleTableWrite.run(context({ modules: MODULES }))).toHaveLength(0);
    });

    it("flags an insert into an owned table from another module", () => {
        expect.assertions(2);

        const findings = crossModuleTableWrite.run(context({ inserts: [insert("accounts/signup")], modules: MODULES }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { file: "accounts/signup", owner: "billing", table: "invoices", writer: "accounts" },
            name: "cross_module_table_write",
        });
    });

    it("flags an insert from a file outside every module", () => {
        expect.assertions(1);

        const findings = crossModuleTableWrite.run(context({ inserts: [insert("legacy")], modules: MODULES }));

        expect(findings[0]?.detail).toContain("outside every module");
    });

    it("stays silent for the owner (any depth) and an unowned table", () => {
        expect.assertions(1);

        const inserts = [insert("billing/invoices"), insert("billing/invoices/create"), insert("accounts/signup", "users")];

        expect(crossModuleTableWrite.run(context({ inserts, modules: MODULES }))).toHaveLength(0);
    });

    it("treats lunora/billing.ts as outside the billing folder", () => {
        expect.assertions(1);

        expect(crossModuleTableWrite.run(context({ inserts: [insert("billing")], modules: MODULES }))[0]?.detail).toContain("outside every module");
    });
});
