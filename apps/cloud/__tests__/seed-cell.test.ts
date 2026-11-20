import { describe, expect, it } from "vitest";

import { DEV_CELL_NAME, planSeedCell, RESEED_HINT } from "../scripts/seed";

/**
 * The dev seed's cell (`scripts/seed.ts`): local dev runs as cell `default`, so
 * the seed uses or creates it, and refuses — saying how to reseed — a database
 * whose cells could never deploy locally.
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

    it("refuses, saying exactly how to reseed, when no cell is the default one", () => {
        const plan = planSeedCell([{ _id: "c1", name: "dev-cell" }]);

        expect(plan).toMatchObject({ kind: "refuse" });
        expect(plan.kind === "refuse" ? plan.message : "").toContain(`Reseed with a fresh database: ${RESEED_HINT}`);
        expect(planSeedCell([{ _id: "c1", name: "eu-1" }])).toMatchObject({ kind: "refuse" });
    });
});
