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

    it("flags app code inserting straight into an installed component's table, but not the component's own folder", () => {
        expect.assertions(3);

        const modules = [...MODULES, { installed: true as const, name: "voting", tables: ["voting_votes"] }];
        const findings = crossModuleTableWrite.run(context({ inserts: [insert("posts", "voting_votes"), insert("voting/cast", "voting_votes")], modules }));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain("the installed component `voting`");
        expect(findings[0]?.metadata).toMatchObject({ installed: true, owner: "voting" });
    });

    it("counts by-id and facade writes, and reports a function once per table", () => {
        expect.assertions(2);

        const tableWrites = [
            { exportName: "create", file: "accounts/signup", line: 4, method: "patch", table: "invoices" },
            { exportName: "create", file: "accounts/signup", line: 5, method: "delete", table: "invoices" },
            { exportName: "close", file: "accounts/close", line: 2, method: "upsert", table: "invoices" },
        ];
        const findings = crossModuleTableWrite.run(context({ modules: MODULES, tableWrites }));

        expect(findings.map((finding) => finding.metadata["exportName"])).toStrictEqual(["create", "close"]);
        expect(findings[0]?.detail).toContain("writes to `invoices`");
    });

    it("flags a write in a helper no export calls, named by the helper rather than an empty export", () => {
        expect.assertions(3);

        const findings = crossModuleTableWrite.run(
            context({
                modules: MODULES,
                tableWrites: [
                    { exportName: "", file: "accounts/signup", helper: "voidInvoice", line: 9, method: "delete", table: "invoices" },
                    { exportName: "", file: "accounts/signup", helper: "voidInvoice", line: 10, method: "patch", table: "invoices" },
                    { exportName: "", file: "accounts/boot", line: 2, method: "patch", table: "invoices" },
                ],
            }),
        );

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual([
            "cross_module_table_write:accounts/signup:voidInvoice:invoices",
            "cross_module_table_write:accounts/boot:line 2:invoices",
        ]);
        expect(findings[0]?.detail).toBe(
            "`voidInvoice` (accounts/signup, a non-exported helper no exported function calls) writes to `invoices`, which module `billing` owns, from module `accounts`.",
        );
        expect(findings[0]?.metadata).toStrictEqual({
            exportName: "",
            file: "accounts/signup",
            helper: "voidInvoice",
            line: 9,
            owner: "billing",
            table: "invoices",
            writer: "accounts",
        });
    });
});
