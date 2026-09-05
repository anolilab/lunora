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
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
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
        expect(output).toContain("options.importGlobals = buildGlobalImporter(database, this.cdcEnabled);");
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

        expect(output).toContain(
            'import { applyCdcChanges, createD1CtxDb, exportGlobalRows, facetGlobalColumn, importGlobalRows, listGlobalTables, readD1CdcChanges, readGlobalTablePage, retryingExec } from "@lunora/d1";',
        );
        expect(output).toContain("return importGlobalRows(writer, schema as unknown as");
    });

    it("wraps the D1 exec so .global() reads retry D1's transient failures", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        // Every `.global()` read runs through this exec, not through a
        // `D1Client` — so an unwrapped exec means the app eats D1's documented
        // baseline error rate on every read no matter what the client offers.
        expect(output).toContain(
            "const buildExec = (database: D1DatabaseLike, bookmark?: string, onBookmark?: (bookmark: string | undefined) => void): D1Exec => {",
        );
        expect(output).toContain("return retryingExec({");
    });

    it("imports AdminTableResolver from @lunora/runtime alongside GlobalIntrospector", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("AdminTableResolver");
    });

    it("omits the admin-import wiring entirely for an app with no .global() table", () => {
        expect.assertions(6);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("resolveTableSharding");
        expect(output).not.toContain("importGlobals");
        expect(output).not.toContain("buildGlobalImporter");
        expect(output).not.toContain("exportGlobals");
        expect(output).not.toContain("syncGlobals");
        expect(output).not.toContain("applyGlobals");
    });

    it("omits the admin-import wiring for a Hyperdrive-backed global app (D1-only wiring)", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).not.toContain("resolveTableSharding");
    });
});

// The import half above is only a quarter of the global admin plane. `@lunora/runtime`
// also reads `exportGlobals` (export + `lunora backup create` + the scheduled R2
// backup), `syncGlobals` (CDC sync + the warehouse-connector feed) and `applyGlobals`
// (point-in-time-recovery apply) off the worker options, and every one of them is
// guarded by a bare `if (option)` — so an unset option is not an error, it is a 200
// with the global storage plane missing from the answer. Export was the severe one:
// `importGlobals` IS wired, so an export→import round trip restored cleanly having
// silently dropped every `.global()` row from the backup.
describe("emitApp — admin export/sync/apply wiring (.global())", () => {
    it("wires options.exportGlobals so backups and exports cover the global plane", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("options.exportGlobals = buildGlobalExporter(database);");
        expect(output).toContain("const buildGlobalExporter =");
        expect(output).toContain('exportGlobalRows(buildExec(database), schema as unknown as D1CtxDbOptions["schema"], { tables: request.tables })');
    });

    it("wires options.syncGlobals + options.applyGlobals for CDC sync and PITR apply", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("options.syncGlobals = buildGlobalCdcSync(database);");
        expect(output).toContain("options.applyGlobals = buildGlobalCdcApplier(database, this.cdcEnabled);");
        expect(output).toContain("const buildGlobalCdcSync =");
        expect(output).toContain("const buildGlobalCdcApplier =");
    });

    // The global `__cdc_log` is created lazily, and only when the writer runs with
    // CDC enabled — so on most apps it does not exist at all. `readD1CdcChanges`
    // throws `no such table: __cdc_log` against a database without it, which would
    // turn "nothing has changed yet" into a 500 on the sync endpoint. The shard-local
    // twin (`runShardCdcSync`) probes `sqlite_master` and returns an empty page; the
    // emitted global twin must do the same.
    it("syncGlobals probes for __cdc_log and returns an empty page when the log does not exist", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("const present = await exec.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [\"__cdc_log\"]);");
        expect(output).toContain("return { changes: [], cursor: request.sinceSeq };");
        expect(output).toContain("const page = await readD1CdcChanges(exec, { limit: request.limit, sinceSeq: request.sinceSeq });");
    });

    it("applyGlobals replays through the same D1 writer and reports the count", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("await applyCdcChanges(writer, request.changes as unknown as Parameters<typeof applyCdcChanges>[1]);");
        expect(output).toContain("return request.changes.length;");
    });

    it("omits the export/sync/apply wiring for a Hyperdrive-backed global app (D1-only wiring)", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).not.toContain("exportGlobals");
        expect(output).not.toContain("syncGlobals");
        expect(output).not.toContain("applyGlobals");
    });
});

// Issue #600: on a database that has never been migrated, `/api/auth/*` 500s
// with `no such table: rateLimit` — better-auth's durable rate limiter runs
// ahead of every handler. The cause is the cold-start window: `auth` used to be
// assigned BEFORE `ensureMigrated` resolved, so a concurrent request saw a
// non-null `auth` and served auth against tables that did not exist yet.
describe("emitApp — auth cold start", () => {
    it("assigns `auth` only once the migration has resolved", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasAuth: true });
        const migration = output.indexOf("await ensureMigrated(createAuth(");
        const assignment = output.indexOf("auth = createAuth({ ...this.authDeclaration.options(env), database: lunoraD1Adapter(");

        expect(migration).toBeLessThan(assignment);
    });

    it("single-flights init on the promise, so concurrent cold requests run one migration", () => {
        // better-auth's migrator emits a bare `CREATE TABLE` (no IF NOT EXISTS),
        // so a second concurrent run on a fresh database fails with `table user
        // already exists` — and because `ensureAuth` is awaited ahead of the
        // router, that 500s every route, not just `/api/auth/*`. Guarding on
        // `auth` alone cannot do this: the assignment is now behind an `await`.
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasAuth: true });

        expect(output).toContain("let authInit: Promise<void> | null = null;");
        expect(output).toContain("(authInit ??= initAuth(env).catch((error: unknown) => {");
        expect(output).toContain("authInit = null;");
    });

    it("retries after a failed init instead of replaying the rejection forever", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasAuth: true });
        const eviction = output.indexOf("authInit = null;");
        const rethrow = output.indexOf("throw error;", eviction);

        expect(rethrow).toBeGreaterThan(eviction);
    });

    it("migrates through the raw binding, never the adapter better-auth rejects", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasAuth: true });

        expect(output).toContain("await ensureMigrated(createAuth({ ...this.authDeclaration.options(env), database: d1(env) as never }));");
        expect(output).not.toContain("ensureMigrated(createAuth({ ...this.authDeclaration.options(env), database: lunoraD1Adapter(");
    });
});

// Issue #601: the writer is rebuilt per request (it carries the caller's
// identity and D1 bookmark), so a per-instance provisioning memo re-runs the
// whole CREATE-IF-NOT-EXISTS sweep on every request's first `.global()` access.
describe("emitApp — per-isolate provisioning scope", () => {
    it("scopes the D1 writer's provisioning to the binding", () => {
        expect.assertions(1);

        expect(emitApp({ ...baseOptions, hasGlobal: true })).toContain("provisionScope: database,");
    });

    it("scopes the Hyperdrive writer's provisioning to the declaration, not the per-request exec", () => {
        // `exec(env)` is a user callback that builds a fresh client per call, so
        // scoping to its result keys the memo on a new object every request and
        // shares nothing — inert, and indistinguishable from having no scope.
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).toContain("provisionScope: declaration,");
        expect(output).not.toContain("provisionScope: exec,");
    });
});
