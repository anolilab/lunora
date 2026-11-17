/**
 * Refinements on tables a package extension contributes. Codegen once read such
 * a table from the package at runtime and dropped every `.min()`/`.max()`, so a
 * deployed baseline from then never recorded them. The first snapshot that does
 * must not report each bound the column always had as newly gained — a breaking
 * change nothing made — while a real gain is still caught once the baseline
 * records them, and an app's own tables keep the check throughout.
 */
import { describe, expect, it } from "vitest";

import type { DriftChange, SchemaSnapshot } from "../../../shared/schema-snapshot";
import { diffSchemaSnapshots } from "../../../shared/schema-snapshot";
import type { TableIR, ValidatorIR } from "../src/ir";
import { buildSchemaSnapshot } from "../src/schema-drift";

const amount = (refined: boolean): ValidatorIR => (refined ? { hasRefinement: true, kind: "number" } : { kind: "number" });

const table = (refined: boolean, fromPackage: boolean): TableIR => {
    return {
        ...(fromPackage ? { extensionFromPackage: true as const } : {}),
        indexes: [],
        name: "payment_sessions",
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape: { amountMinor: amount(refined) },
        shardMode: "root",
        vectorIndexes: [],
    };
};

const snapshotOf = (refined: boolean, fromPackage: boolean): SchemaSnapshot =>
    buildSchemaSnapshot({ tables: [table(refined, fromPackage)], vectorIndexes: [] }, []);

/** A baseline as the older codegen wrote it for a package table: no bounds, no marker. */
const legacyPackageBaseline = (): SchemaSnapshot => {
    const snapshot = snapshotOf(false, true);
    const legacy = { ...snapshot.tables["payment_sessions"] } as SchemaSnapshot["tables"][string];

    delete legacy.refinementsRecorded;

    return { ...snapshot, tables: { payment_sessions: legacy } };
};

const refinementChanges = (baseline: SchemaSnapshot, current: SchemaSnapshot): ReadonlyArray<DriftChange> =>
    diffSchemaSnapshots(baseline, current).changes.filter((change) => change.summary.includes("validation refinement"));

describe("schema drift — package-table refinements", () => {
    it("does not report a bound the package column always had on the first deploy that records it", () => {
        expect.assertions(1);

        expect(refinementChanges(legacyPackageBaseline(), snapshotOf(true, true))).toStrictEqual([]);
    });

    it("reports a bound a package column really gains once the baseline records them", () => {
        expect.assertions(2);

        const [change] = refinementChanges(snapshotOf(false, true), snapshotOf(true, true));

        expect(change?.severity).toBe("breaking");
        expect(change?.type).toBe("addedFieldConstraint");
    });

    it("keeps checking an app's own tables, which always recorded their bounds", () => {
        expect.assertions(1);

        expect(refinementChanges(snapshotOf(false, false), snapshotOf(true, false)).map((change) => change.severity)).toStrictEqual(["breaking"]);
    });
});
