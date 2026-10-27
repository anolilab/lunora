import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import type { ExportRow, SqlExec } from "@lunora/sql-store";
import { expect } from "vitest";

import { v } from "../../../values/src/v";
import { decodeWire } from "../../../wire/src/index";
import type { HyperdriveEngine } from "../../src/global";
import {
    applyHyperdriveGlobalCdc,
    createHyperdriveGlobalCtxDb,
    createHyperdriveGlobalIntrospector,
    exportHyperdriveGlobalRows,
    importHyperdriveGlobalRows,
    readHyperdriveGlobalCdc,
} from "../../src/global";

/**
 * The admin plane of a Hyperdrive `.global()` store — bulk export/import, the
 * studio's global browser, and the CDC sync/apply pair — against a real
 * Postgres or MySQL. These are what a generated worker wires as
 * `exportGlobals` / `importGlobals` / `globalIntrospector` / `syncGlobals` /
 * `applyGlobals`, and what `lunora migrate d1-to-hyperdrive` and its reverse
 * drive.
 *
 * Handed back as `[name, run]` pairs for each suite's own `it.each`. Every case
 * expects the tables it names not to exist yet.
 */
interface AdminPlaneTarget {
    engine: HyperdriveEngine;
    exec: SqlExec;
    /** Run raw SQL on the engine. */
    query: (statement: string) => Promise<Record<string, unknown>[]>;
}

const CLOCK = 1_700_000_000_000;

const schema = {
    tables: {
        assets: {
            indexes: [],
            shape: { big: v.bigint(), blob: v.bytes(), count: v.number(), name: v.string(), note: v.optional(v.string()) },
            shardMode: { kind: "global" },
        },
        extras: { indexes: [], shape: { label: v.string() }, shardMode: { kind: "global" } },
    },
} as unknown as SchemaLike;

const writerFor = (target: AdminPlaneTarget, cdc = false): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ cdc, clock: () => CLOCK, engine: target.engine, exec: target.exec, schema });

const collect = async (target: AdminPlaneTarget, tables?: ReadonlyArray<string>): Promise<ExportRow[]> => {
    const rows: ExportRow[] = [];

    for await (const row of exportHyperdriveGlobalRows({ engine: target.engine, exec: target.exec, schema, ...(tables === undefined ? {} : { tables }) })) {
        rows.push(row);
    }

    return rows;
};

const tableExists = async (target: AdminPlaneTarget, table: string): Promise<boolean> => {
    const scope = target.engine === "postgres" ? "current_schema()" : "DATABASE()";
    const rows = await target.query(`SELECT 1 AS hit FROM information_schema.tables WHERE table_schema = ${scope} AND table_name = '${table}'`);

    return rows.length > 0;
};

const asset = (id: string, count: number): Record<string, unknown> => {
    return { _id: id, big: 12_345_678_901_234_567_890n, blob: new Uint8Array([1, 2, 255]).buffer, count, name: `asset-${id}` };
};

const roundTripCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target);

    await writer.insert("assets", asset("a1", 1), { allowExplicitId: true });
    await writer.insert("assets", { ...asset("a2", 2), note: "kept" }, { allowExplicitId: true });

    const before = [await writer.get("assets", "a1"), await writer.get("assets", "a2")];
    // Exported rows cross JSON on their way to the CLI; the bigint and bytes survive only wire-encoded.
    const wire = JSON.stringify(await collect(target, ["assets"]));
    const exported = JSON.parse(wire) as ExportRow[];

    expect(exported.map((row) => row.doc["_id"])).toStrictEqual(["a1", "a2"]);
    // An unset optional column is SQL NULL on disk and must export as absent, not `null`.
    expect(exported[0]?.doc).not.toHaveProperty("note");

    await writer.delete("assets", "a1");
    await writer.delete("assets", "a2");

    const result = await importHyperdriveGlobalRows({ cdc: false, engine: target.engine, exec: target.exec, rows: exported, schema });

    expect(result).toStrictEqual({ conflicts: 0, errors: [], inserted: { assets: 2 }, replaced: 0 });
    expect([await writer.get("assets", "a1"), await writer.get("assets", "a2")]).toStrictEqual(before);
    expect(decodeWire(exported[0]?.doc)).toMatchObject({ big: 12_345_678_901_234_567_890n });
};

const dryRunCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const result = await importHyperdriveGlobalRows({
        cdc: false,
        dryRun: true,
        engine: target.engine,
        exec: target.exec,
        rows: [
            { doc: { _id: "x1", label: "ok" }, table: "extras" },
            { doc: { _id: "x2", label: 7 }, table: "extras" },
        ],
        schema,
    });

    expect(result.inserted).toStrictEqual({});
    expect(result.errors).toMatchObject([{ code: "VALIDATION_ERROR", line: 2, table: "extras" }]);
    // Not even provisioned: a dry run must not reach the database at all.
    await expect(tableExists(target, "extras")).resolves.toBe(false);
};

const conflictCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target);

    await writer.insert("extras", { _id: "x1", label: "target" }, { allowExplicitId: true });

    const result = await importHyperdriveGlobalRows({
        cdc: false,
        engine: target.engine,
        exec: target.exec,
        rows: [
            { doc: { _creationTime: CLOCK - 5, _id: "x1", label: "source" }, table: "extras" },
            { doc: { _id: "x2", label: "new" }, table: "extras" },
        ],
        schema,
    });

    expect(result).toStrictEqual({ conflicts: 1, errors: [], inserted: { extras: 1 }, replaced: 0 });
    await expect(writer.get("extras", "x1")).resolves.toMatchObject({ label: "target" });
};

const replaceCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target, true);

    await writer.insert("extras", { _id: "x1", label: "copied" }, { allowExplicitId: true });

    const result = await importHyperdriveGlobalRows({
        cdc: true,
        engine: target.engine,
        exec: target.exec,
        onConflict: "replace",
        rows: [{ doc: { _creationTime: CLOCK - 5, _id: "x1", label: "changed on the source" }, table: "extras" }],
        schema,
    });

    expect(result).toStrictEqual({ conflicts: 0, errors: [], inserted: {}, replaced: 1 });
    await expect(writer.get("extras", "x1")).resolves.toStrictEqual({ _creationTime: CLOCK - 5, _id: "x1", label: "changed on the source" });

    // Recorded in the changelog like any other write, so a downstream consumer sees the overwrite.
    const page = await readHyperdriveGlobalCdc(target.engine, target.exec, { sinceSeq: 0 });

    expect(page.changes.map((change) => [change.op, change.id])).toStrictEqual([
        ["insert", "x1"],
        ["update", "x1"],
    ]);
};

const neverWrittenCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    await expect(collect(target)).resolves.toStrictEqual([]);
    // Provisioned on the way, so the next export (and a later import) finds it.
    await expect(tableExists(target, "assets")).resolves.toBe(true);
};

const allowlistCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target);

    await writer.insert("assets", asset("a1", 1), { allowExplicitId: true });
    await writer.insert("extras", { _id: "x1", label: "only" }, { allowExplicitId: true });

    const rows = await collect(target, ["extras"]);

    expect(rows.map((row) => [row.table, row.doc["_id"]])).toStrictEqual([["extras", "x1"]]);
    await expect(collect(target)).resolves.toHaveLength(2);
};

const pagingCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target);
    const ids = Array.from({ length: 205 }, (_, index) => `x${String(index).padStart(3, "0")}`);

    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- seeding in order through one connection
        await writer.insert("extras", { _id: id, label: id }, { allowExplicitId: true });
    }

    // Past the 200-row page, so the keyset continuation has to render and run.
    await expect(collect(target, ["extras"]).then((rows) => rows.map((row) => row.doc["_id"]))).resolves.toStrictEqual(ids);
};

const introspectorCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    const writer = writerFor(target);

    await writer.insert("extras", { _id: "x1", label: "a" }, { allowExplicitId: true });
    await writer.insert("extras", { _id: "x2", label: "a" }, { allowExplicitId: true });
    await writer.insert("extras", { _id: "x3", label: "b" }, { allowExplicitId: true });

    const introspector = createHyperdriveGlobalIntrospector(target.engine, target.exec, schema);
    const tables = await introspector.listTables();

    expect(tables).toStrictEqual(
        expect.arrayContaining([
            { name: "assets", rowCount: 0 },
            { name: "extras", rowCount: 3 },
        ]),
    );
    expect(tables.some((table) => table.name.startsWith("__"))).toBe(false);

    await expect(introspector.readTablePage({ filters: [{ column: "label", value: "a" }], limit: 1, offset: 1, table: "extras" })).resolves.toStrictEqual({
        columns: ["_id", "_creationTime", "label"],
        rows: [{ _creationTime: CLOCK, _id: "x2", label: "a" }],
        total: 2,
    });
    await expect(introspector.facetColumn({ column: "label", table: "extras" })).resolves.toStrictEqual({
        truncated: false,
        values: [
            { count: 2, value: "a" },
            { count: 1, value: "b" },
        ],
    });
    await expect(introspector.readTablePage({ table: "__lunora_migration_state" })).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
};

const externalTablesCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    // Tables the app does not own, e.g. an auth library's.
    await target.query("CREATE TABLE ext_users (id INTEGER PRIMARY KEY, passwordHash VARCHAR(64))");
    await target.query("CREATE TABLE ext_posts (id INTEGER PRIMARY KEY, user_id INTEGER, FOREIGN KEY (user_id) REFERENCES ext_users (id))");
    await target.query("INSERT INTO ext_users (id, passwordHash) VALUES (2, 'secret'), (1, 'hunter2')");

    const introspector = createHyperdriveGlobalIntrospector(target.engine, target.exec, schema);

    await expect(introspector.listTables()).resolves.toStrictEqual(
        expect.arrayContaining([
            { name: "ext_posts", rowCount: 0 },
            { name: "ext_users", rowCount: 2 },
        ]),
    );
    // Ordered by the table's own primary key, secrets masked. Postgres folds the unquoted column name to lower case.
    await expect(introspector.readTablePage({ table: "ext_users" }).then((page) => page.rows)).resolves.toStrictEqual([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
    ]);
    await expect(introspector.readTablePage({ table: "ext_users" })).resolves.toMatchObject({
        rows: [target.engine === "postgres" ? { passwordhash: "•••" } : { passwordHash: "•••" }, expect.anything()],
    });
    await expect(introspector.readTablePage({ table: "ext_posts" })).resolves.toMatchObject({ refs: { user_id: "ext_users" } });
};

const keylessTablePagingCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    // The first column ties on every row and the heap order (descending `n`) disagrees with the
    // tiebreak, so only an ORDER BY over every column returns the rows in a stable, page-safe order.
    await target.query("CREATE TABLE ext_log (kind VARCHAR(8), n INTEGER)");
    await target.query("INSERT INTO ext_log (kind, n) VALUES ('x', 3), ('x', 2), ('x', 1)");

    const introspector = createHyperdriveGlobalIntrospector(target.engine, target.exec, schema);
    const pages = [
        await introspector.readTablePage({ limit: 2, offset: 0, table: "ext_log" }),
        await introspector.readTablePage({ limit: 2, offset: 2, table: "ext_log" }),
    ];

    expect(pages.flatMap((page) => page.rows.map((row) => row["n"]))).toStrictEqual([1, 2, 3]);
};

const cdcCase = (target: AdminPlaneTarget) => async (): Promise<void> => {
    // No changelog yet is "nothing has changed", not an error, and the cursor stays put.
    await expect(readHyperdriveGlobalCdc(target.engine, target.exec, { sinceSeq: 7 })).resolves.toStrictEqual({ changes: [], cursor: 7 });

    const writer = writerFor(target, true);

    await writer.insert("extras", { _id: "x1", label: "one" }, { allowExplicitId: true });
    await writer.patch("extras", "x1", { label: "two" });

    const page = await readHyperdriveGlobalCdc(target.engine, target.exec, { sinceSeq: 0 });

    expect(page.changes.map((change) => change.op)).toStrictEqual(["insert", "update"]);

    // Point-in-time apply: replaying the log onto a database that lost the row restores it.
    await writer.delete("extras", "x1");

    const replayed = await applyHyperdriveGlobalCdc({ cdc: false, changes: page.changes, engine: target.engine, exec: target.exec, schema });

    expect(replayed).toBe(2);
    await expect(writer.get("extras", "x1")).resolves.toMatchObject({ label: "two" });
};

const adminPlaneCases = (target: AdminPlaneTarget): [string, () => Promise<void>][] => [
    ["exports then re-imports rows intact (bigint, bytes, unset optional)", roundTripCase(target)],
    ["dry-run import checks shapes and writes nothing, not even the table", dryRunCase(target)],
    ["reports an existing _id as a conflict and leaves the stored row unchanged", conflictCase(target)],
    ['overwrites an existing _id under onConflict: "replace", keeping the snapshot _creationTime and recording CDC', replaceCase(target)],
    ["exports a never-written table as empty instead of failing", neverWrittenCase(target)],
    ["exports only the allowlisted tables", allowlistCase(target)],
    ["keyset-pages an export past one batch", pagingCase(target)],
    ["pages, filters and facets a schema table for the studio browser", introspectorCase(target)],
    ["shows external tables keyed by their own primary key, with secrets masked and foreign keys named", externalTablesCase(target)],
    ["pages a keyless external table in a stable order even when its first column ties", keylessTablePagingCase(target)],
    ["reads and replays the global changelog", cdcCase(target)],
];

/** Tables the cases create, child before parent, for a suite that shares one server across tests. */
const ADMIN_PLANE_TABLES = ["ext_posts", "ext_users", "assets", "extras"] as const;

export { ADMIN_PLANE_TABLES, adminPlaneCases };
