import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorInsertWrite, AdvisorTableWrite, LintContext } from "../src";
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
    return { scope: { kind: "export", name: "create" }, file, line: 3, table };
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

        const tableWrites: AdvisorTableWrite[] = [
            { file: "accounts/signup", line: 4, method: "patch", scope: { kind: "export", name: "create" }, table: "invoices" },
            { file: "accounts/signup", line: 5, method: "delete", scope: { kind: "export", name: "create" }, table: "invoices" },
            { file: "accounts/close", line: 2, method: "upsert", scope: { kind: "export", name: "close" }, table: "invoices" },
        ];
        const findings = crossModuleTableWrite.run(context({ modules: MODULES, tableWrites }));

        expect(findings.map((finding) => finding.metadata["exportName"])).toStrictEqual(["create", "close"]);
        expect(findings[0]?.detail).toContain("writes to `invoices`");
    });

    it("reports a write in a shared helper once, naming the helper and the exports calling it", () => {
        expect.assertions(3);

        const scope = { callers: ["signupTransitive", "signupViaHelper"], kind: "helper" as const, name: "openInvoice" };
        const findings = crossModuleTableWrite.run(
            context({
                modules: MODULES,
                tableWrites: [
                    { file: "accounts/signup", line: 9, method: "patch", scope, table: "invoices" },
                    { file: "accounts/signup", line: 10, method: "delete", scope, table: "invoices" },
                ],
            }),
        );

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["cross_module_table_write:accounts/signup:openInvoice:invoices"]);
        expect(findings[0]?.detail).toBe(
            "`openInvoice` (a helper called by `signupTransitive`, `signupViaHelper`) (accounts/signup) writes to `invoices`, which module `billing` owns, from module `accounts`.",
        );
        expect(findings[0]?.metadata).toStrictEqual({
            callers: ["signupTransitive", "signupViaHelper"],
            file: "accounts/signup",
            helper: "openInvoice",
            owner: "billing",
            table: "invoices",
            writer: "accounts",
        });
    });

    it("still flags a write in a helper no export calls, and keys module scope without a line", () => {
        expect.assertions(2);

        const findings = crossModuleTableWrite.run(
            context({
                modules: MODULES,
                tableWrites: [
                    { file: "accounts/signup", line: 9, method: "delete", scope: { callers: [], kind: "helper", name: "voidInvoice" }, table: "invoices" },
                    { file: "accounts/boot", line: 2, method: "patch", scope: { kind: "module" }, table: "invoices" },
                ],
            }),
        );

        // Line-free keys: a saved dismissal survives the code moving.
        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual([
            "cross_module_table_write:accounts/signup:voidInvoice:invoices",
            "cross_module_table_write:accounts/boot:<module>:invoices",
        ]);
        expect(findings[0]?.detail).toContain("`voidInvoice` (a non-exported helper no exported function calls)");
    });
});
