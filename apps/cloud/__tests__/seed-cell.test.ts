import { describe, expect, it } from "vitest";

import { DEV_CELL_NAME, LEGACY_DEV_CELL_NAME, planSeedCell, renameLegacyCellSql, RESEED_HINT } from "../scripts/seed";

/**
 * The dev seed's cell (`scripts/seed.ts`): local dev runs as cell `default`, and a
 * database seeded before that rule holds a lone `dev-cell` whose projects could
 * never deploy. The seed renames it — in the local D1 file only — or says how to
 * reseed when no single rename would fix the database.
 */
describe(planSeedCell, () => {
    it("uses the default cell, and creates it in an empty fleet", () => {
        expect(
            planSeedCell([
                { _id: "c1", name: "eu-1" },
                { _id: "c2", name: DEV_CELL_NAME },
            ]),
        ).toStrictEqual({
            cell: { _id: "c2", name: "default" },
            kind: "use",
        });
        expect(planSeedCell([])).toStrictEqual({ kind: "create" });
    });

    it("renames a lone pre-rename dev-cell, keeping its row (and so the org placed on it)", () => {
        expect(planSeedCell([{ _id: "c1", name: LEGACY_DEV_CELL_NAME }])).toStrictEqual({ cell: { _id: "c1", name: "dev-cell" }, kind: "rename" });
    });

    it("refuses, saying exactly how to reseed, when no single rename would fix the database", () => {
        const plan = planSeedCell([
            { _id: "c1", name: LEGACY_DEV_CELL_NAME },
            { _id: "c2", name: "other" },
        ]);

        expect(plan).toMatchObject({ kind: "refuse" });
        expect(plan.kind === "refuse" ? plan.message : "").toContain(`Reseed with a fresh database: ${RESEED_HINT}`);
        expect(planSeedCell([{ _id: "c1", name: "eu-1" }])).toMatchObject({ kind: "refuse" });
    });
});

describe(renameLegacyCellSql, () => {
    it("renames only that row, and only while it still carries the legacy name", () => {
        expect(renameLegacyCellSql("2b6c8d1e-3f40-4d0e-9a51-0f9a1c2e7b44")).toBe(
            "UPDATE cells SET name = 'default' WHERE _id = '2b6c8d1e-3f40-4d0e-9a51-0f9a1c2e7b44' AND name = 'dev-cell';",
        );
    });

    it("refuses an id it would have to interpolate unsafely", () => {
        expect(() => renameLegacyCellSql("x'; DROP TABLE cells; --")).toThrow("not a row id");
    });
});
