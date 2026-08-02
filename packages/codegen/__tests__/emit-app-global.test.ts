import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

// Issue #287: `POST /_lunora/admin/import` needs `resolveTableSharding` and
// `importGlobals` wired on the worker, or a `.global()` table silently never
// reaches the import path — the endpoint answers 200 with `inserted: {}` for a
// write that never happened. Both are mechanical over the schema this file
// already imports when the app has a D1-backed `.global()` table, so codegen
// emits them the same way it already emits `runShardExport`/`runShardImport`.
describe("emitApp — admin bulk-import wiring (.global())", () => {
    it("wires options.resolveTableSharding + options.importGlobals when the app has a .global() table", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("options.resolveTableSharding = buildTableShardingResolver();");
        expect(output).toContain("options.importGlobals = buildGlobalImporter(database);");
        expect(output).toContain("const buildTableShardingResolver = (): AdminTableResolver =>");
        expect(output).toContain("const buildGlobalImporter =");
    });

    it("resolveTableSharding is a mechanical lookup over each table's declared shardMode", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain('const declared = (schema as unknown as D1CtxDbOptions["schema"]).tables[table];');
        expect(output).toContain("return declared?.shardMode ? { mode: declared.shardMode } : undefined;");
    });

    it("importGlobals routes rows through @lunora/d1's importGlobalRows over the same D1 writer", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain('import { createD1CtxDb, facetGlobalColumn, importGlobalRows, listGlobalTables, readGlobalTablePage } from "@lunora/d1";');
        expect(output).toContain("return importGlobalRows(writer, schema as unknown as");
    });

    it("imports AdminTableResolver from @lunora/runtime alongside GlobalIntrospector", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("AdminTableResolver");
    });

    it("omits the admin-import wiring entirely for an app with no .global() table", () => {
        expect.assertions(3);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("resolveTableSharding");
        expect(output).not.toContain("importGlobals");
        expect(output).not.toContain("buildGlobalImporter");
    });

    it("omits the admin-import wiring for a Hyperdrive-backed global app (D1-only wiring)", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).not.toContain("resolveTableSharding");
    });
});
