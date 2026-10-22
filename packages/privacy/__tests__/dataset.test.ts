import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset, erasureOrder, PortTableMissingError, requireTables, retainedTables } from "../src/dataset";
import { retain } from "../src/rules";

const base = {
    legalBasis: "contract" as const,
    origin: "provided" as const,
    purpose: "Tasks the user schedules",
    tables: { goals: {}, tasks: { omit: ["activeCycle"] } },
};

const codeOf = (run: () => unknown): string => {
    try {
        run();
    } catch (error) {
        return error instanceof LunoraError ? error.code : "not-lunora";
    }

    return "no-error";
};

describe(defineDataset, () => {
    it("fills the defaults: erase phase, subject placement, no recipients", () => {
        const dataset = defineDataset("tasks", base);

        expect(dataset).toMatchObject({ id: "tasks", phase: "erase", placement: "subject", recipients: [] });
        expect(dataset.tableNames).toStrictEqual(["goals", "tasks"]);
    });

    it("refuses an id that is not a lowercase identifier", () => {
        expect(codeOf(() => defineDataset("Tasks-Module", base))).toBe("BAD_REQUEST");
    });

    it("refuses an empty purpose", () => {
        expect(codeOf(() => defineDataset("tasks", { ...base, purpose: "   " }))).toBe("BAD_REQUEST");
    });

    it("refuses a dataset with no tables", () => {
        expect(codeOf(() => defineDataset("tasks", { ...base, tables: {} }))).toBe("BAD_REQUEST");
    });
});

describe(requireTables, () => {
    const dataset = defineDataset("tasks", base);

    it("accepts a result with an entry for every table", () => {
        expect(() => {
            requireTables({ goals: [], tasks: [] }, dataset, "remaining");
        }).not.toThrow();
    });

    it("names the missing table and its dataset", () => {
        expect(() => {
            requireTables({ goals: [] }, dataset, "remaining");
        }).toThrow(new PortTableMissingError("remaining", "tasks", "tasks"));
    });

    it("does not count an inherited property as an entry", () => {
        // A dataset table named like an Object.prototype member must not pass through the prototype.
        const named = defineDataset("labels", { ...base, tables: { toString: {} } });

        expect(() => {
            requireTables({}, named, "remaining");
        }).toThrow(PortTableMissingError);
    });
});

describe(erasureOrder, () => {
    it("runs quiesce datasets first and tombstones last, keeping the declared order within a phase", () => {
        const order = erasureOrder([
            defineDataset("billing", base),
            defineDataset("scheduler", { ...base, phase: "quiesce" }),
            defineDataset("restore", { ...base, phase: "tombstone" }),
            defineDataset("notes", base),
        ]).map((dataset) => dataset.id);

        expect(order).toStrictEqual(["scheduler", "billing", "notes", "restore"]);
    });
});

describe(retainedTables, () => {
    it("lists only the tables a retention rule may keep, with their directive, in declared order", () => {
        const dataset = defineDataset("billing", {
            legalBasis: "legal_obligation",
            origin: "provided",
            purpose: "Invoices",
            tables: { carts: {}, invoices: { erase: retain("hgb", { from: "issuedAt" }) }, notes: { erase: "anonymise" }, payouts: { erase: retain("ao") } },
        });

        expect(retainedTables(dataset)).toStrictEqual([
            { directive: retain("hgb", { from: "issuedAt" }), table: "invoices" },
            { directive: retain("ao"), table: "payouts" },
        ]);
    });

    it("is empty for a dataset that only deletes and anonymises", () => {
        expect(
            retainedTables(
                defineDataset("tasks", { legalBasis: "contract", origin: "provided", purpose: "Tasks", tables: { a: {}, b: { erase: "anonymise" } } }),
            ),
        ).toStrictEqual([]);
    });
});
