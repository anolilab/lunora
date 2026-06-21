import { describe, expect, it } from "vitest";

import {
    createD1CtxDb,
    D1Client,
    exportGlobalRows,
    importGlobalRows,
    listGlobalTables,
    MigrationRunner,
    readD1CdcChanges,
    runD1CdcMigration,
    trimD1CdcChanges,
} from "../src/index";

/**
 * The public barrel must expose the full `.global()` CDC surface, not just the
 * migration. `@lunora/runtime`'s `create-worker.ts` documents wiring the admin
 * sync endpoint to `@lunora/d1`'s `readD1CdcChanges`, so it (and its `trim`
 * checkpoint counterpart) has to be reachable from the package entry point.
 */
describe("@lunora/d1 public surface", () => {
    it("exports the CDC read/trim helpers alongside the migration", () => {
        expect.assertions(3);

        expect(typeof runD1CdcMigration).toBe("function");
        expect(typeof readD1CdcChanges).toBe("function");
        expect(typeof trimD1CdcChanges).toBe("function");
    });

    it("exports the core ctx-db, client, migration-runner, and introspection entry points", () => {
        expect.assertions(6);

        expect(typeof createD1CtxDb).toBe("function");
        expect(typeof D1Client).toBe("function");
        expect(typeof MigrationRunner).toBe("function");
        expect(typeof listGlobalTables).toBe("function");
        expect(typeof exportGlobalRows).toBe("function");
        expect(typeof importGlobalRows).toBe("function");
    });
});
