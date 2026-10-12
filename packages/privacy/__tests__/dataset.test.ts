import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { defineDataset, erasureOrder } from "../src/dataset";

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
