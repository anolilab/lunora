import type { DatabaseWriterLike, ExportRow, SchemaLike } from "@lunora/shard-engine";
import {
    ADMIN_FUNCTIONS,
    createShardCtxDb as createShardContextDatabase,
    exportShardRows,
    importShardRows,
    runShardMigrations,
    selectExportTables,
    validateImportRow,
} from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunShardExportArgs, RunShardImportArgs, ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "s3cret-admin";

const minimalParser = (kind: string) => {
    return {
        kind,
        parse(value: unknown) {
            if (kind === "string" && typeof value !== "string") {
                throw new Error(`expected string, received ${typeof value}`);
            }

            if (kind === "number" && typeof value !== "number") {
                throw new Error(`expected number, received ${typeof value}`);
            }

            if (kind === "boolean" && typeof value !== "boolean") {
                throw new Error(`expected boolean, received ${typeof value}`);
            }

            return value;
        },
    };
};

const usersSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            shape: {
                channelId: minimalParser("string"),
                text: minimalParser("string"),
            },
            shardMode: { field: "channelId", kind: "shardBy" } as never,
        },
        users: {
            indexes: [],
            shape: {
                email: minimalParser("string"),
                name: minimalParser("string"),
            },
        },
    },
};

const globalUsersSchema: SchemaLike = {
    tables: {
        global: {
            indexes: [],
            shape: { value: minimalParser("string") },
            shardMode: { kind: "global" } as never,
        },
        local: {
            indexes: [],
            shape: { value: minimalParser("string") },
        },
    },
};

describe("selectExportTables", () => {
    it("returns every shard-local user table when no allowlist is given", () => {
        expect.assertions(1);

        expect(selectExportTables(usersSchema)).toEqual(["messages", "users"]);
    });

    it("filters out global tables", () => {
        expect.assertions(1);

        expect(selectExportTables(globalUsersSchema)).toEqual(["local"]);
    });

    it("respects an explicit allowlist (still skipping globals)", () => {
        expect.assertions(1);

        expect(selectExportTables(globalUsersSchema, ["global", "local"])).toEqual(["local"]);
    });
});

describe("validateImportRow", () => {
    it("accepts a well-formed row", () => {
        expect.assertions(1);

        expect(validateImportRow(usersSchema, "users", { email: "a@b.com", name: "Alice" })).toBeUndefined();
    });

    it("rejects a row whose field fails the validator", () => {
        expect.assertions(1);

        const result = validateImportRow(usersSchema, "users", { email: 42, name: "Alice" });

        expect(result).toMatch(/email/);
    });

    it("ignores `_id` / `_creationTime` (framework-managed)", () => {
        expect.assertions(1);

        expect(
            validateImportRow(usersSchema, "users", {
                _creationTime: 1_700_000_000_000,
                _id: "u1",
                email: "a@b.com",
                name: "Alice",
            }),
        ).toBeUndefined();
    });

    it("rejects unknown tables", () => {
        expect.assertions(1);

        expect(validateImportRow(usersSchema, "nope", {})).toMatch(/unknown table/);
    });
});

describe("exportShardRows / importShardRows roundtrip", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let writer: DatabaseWriterLike;

    beforeEach(async () => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);
        writer = createShardContextDatabase({ schema: usersSchema, sql: database.sql });

        for (let index = 1; index <= 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert(
                "users",
                { _id: `u${String(index)}`, email: `u${String(index)}@x.io`, name: `user ${String(index)}` },
                { allowExplicitId: true },
            );
        }

        for (let index = 1; index <= 2; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("messages", { _id: `m${String(index)}`, channelId: "c1", text: `msg ${String(index)}` }, { allowExplicitId: true });
        }
    });

    afterEach(() => {
        database.close();
    });

    it("exports every row across tables", async () => {
        expect.assertions(3);

        const rows: ExportRow[] = [];

        for await (const row of exportShardRows(writer, usersSchema, {})) {
            rows.push(row);
        }

        expect(rows).toHaveLength(5);
        expect(rows.filter((r) => r.table === "users")).toHaveLength(3);
        expect(rows.filter((r) => r.table === "messages")).toHaveLength(2);
    });

    it("respects a table allowlist", async () => {
        expect.assertions(1);

        const rows: ExportRow[] = [];

        for await (const row of exportShardRows(writer, usersSchema, { tables: ["users"] })) {
            rows.push(row);
        }

        expect(rows.map((r) => r.table)).toEqual(["users", "users", "users"]);
    });

    it("import inserts a batch and surfaces per-table counts", async () => {
        expect.assertions(5);

        const freshDatabase = createSqliteExec();

        runShardMigrations(freshDatabase.sql, usersSchema);
        const freshWriter = createShardContextDatabase({ schema: usersSchema, sql: freshDatabase.sql });

        const rows: ExportRow[] = [
            { doc: { _id: "u9", email: "n@x.io", name: "Nina" }, table: "users" },
            { doc: { _id: "u10", email: "k@x.io", name: "Kai" }, table: "users" },
            { doc: { _id: "m9", channelId: "c1", text: "hello" }, table: "messages" },
        ];

        const result = await importShardRows(freshWriter, usersSchema, { rows });

        expect(result.inserted).toEqual({ messages: 1, users: 2 });
        expect(result.errors).toEqual([]);
        expect(result.conflicts).toBe(0);

        await expect(freshWriter.get("u9")).resolves.toMatchObject({ name: "Nina" });
        await expect(freshWriter.get("m9")).resolves.toMatchObject({ text: "hello" });

        freshDatabase.close();
    });

    it("schema-failed rows do not abort the batch — they're reported in errors[]", async () => {
        expect.assertions(3);

        const freshDatabase = createSqliteExec();

        runShardMigrations(freshDatabase.sql, usersSchema);
        const freshWriter = createShardContextDatabase({ schema: usersSchema, sql: freshDatabase.sql });

        const rows: ExportRow[] = [
            { doc: { _id: "u9", email: "ok@x.io", name: "Nina" }, table: "users" },
            { doc: { _id: "u10", email: 42, name: "Kai" }, table: "users" },
            { doc: { _id: "u11", email: "ok@x.io", name: "May" }, table: "users" },
        ];

        const result = await importShardRows(freshWriter, usersSchema, { rows, startLine: 10 });

        expect(result.inserted).toEqual({ users: 2 });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "VALIDATION_ERROR", line: 11, table: "users" });

        freshDatabase.close();
    });

    it("a row whose _id collides with an existing doc is skipped and counted as a conflict", async () => {
        expect.assertions(3);

        const rows: ExportRow[] = [
            { doc: { _id: "u1", email: "should-not-overwrite@x.io", name: "Doppel" }, table: "users" },
            { doc: { _id: "u99", email: "ok@x.io", name: "Fresh" }, table: "users" },
        ];

        const result = await importShardRows(writer, usersSchema, { rows });

        expect(result.conflicts).toBe(1);
        expect(result.inserted).toEqual({ users: 1 });

        // The original row is still there, unchanged.
        const existing = await writer.get("u1");

        expect(existing).toMatchObject({ email: "u1@x.io" });
    });

    it("roundtrip: export then import into a fresh shard produces identical rows", async () => {
        expect.hasAssertions();

        const exported: ExportRow[] = [];

        for await (const row of exportShardRows(writer, usersSchema, {})) {
            exported.push(row);
        }

        const freshDatabase = createSqliteExec();

        runShardMigrations(freshDatabase.sql, usersSchema);

        const freshWriter = createShardContextDatabase({ schema: usersSchema, sql: freshDatabase.sql });

        const result = await importShardRows(freshWriter, usersSchema, { rows: exported });

        expect(result.inserted).toEqual({ messages: 2, users: 3 });
        expect(result.errors).toEqual([]);

        for (const original of exported) {
            const id = original.doc["_id"] as string;
            // eslint-disable-next-line no-await-in-loop -- sequential per-row reload to verify round-trip
            const reloaded = await freshWriter.get(id);

            expect(reloaded).not.toBeNull();
            expect(reloaded!["_id"]).toBe(id);

            for (const [key, value] of Object.entries(original.doc)) {
                expect(reloaded![key]).toEqual(value);
            }
        }

        freshDatabase.close();
    });
});

// Plan 118: `importOneRow`'s insert-failure catch now routes through
// `toErrorBody` instead of embedding a caught error's raw `.code`/`.message`
// directly. These pin both halves of the invariant: a recognized, non-internal
// `LunoraError` (e.g. `ConflictError`, thrown on a real UNIQUE-index breach)
// still reports its own code/message, while an unrecognized throw is redacted.
describe("importOneRow insert-failure envelope (toErrorBody migration)", () => {
    it("a genuine unique-index conflict still reports its real code + message", async () => {
        expect.assertions(2);

        const uniqueSchema: SchemaLike = {
            tables: {
                users: {
                    indexes: [{ fields: ["email"], name: "by_email", unique: true }],
                    shape: {
                        email: minimalParser("string"),
                        name: minimalParser("string"),
                    },
                },
            },
        };

        const freshDatabase = createSqliteExec();

        runShardMigrations(freshDatabase.sql, uniqueSchema);
        const freshWriter = createShardContextDatabase({ schema: uniqueSchema, sql: freshDatabase.sql });

        await freshWriter.insert("users", { _id: "u1", email: "dup@x.io", name: "First" }, { allowExplicitId: true });

        const rows: ExportRow[] = [{ doc: { _id: "u2", email: "dup@x.io", name: "Second" }, table: "users" }];

        const result = await importShardRows(freshWriter, uniqueSchema, { rows });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("unique constraint violation") });

        freshDatabase.close();
    });

    it("an unrecognized insert failure is redacted instead of leaking the raw error message", async () => {
        expect.assertions(2);

        const freshDatabase = createSqliteExec();

        runShardMigrations(freshDatabase.sql, usersSchema);
        const realWriter = createShardContextDatabase({ schema: usersSchema, sql: freshDatabase.sql });
        const failingWriter: DatabaseWriterLike = {
            ...realWriter,
            insert: () => Promise.reject(new Error("disk io failure: sector 42 unreadable")),
        };

        const rows: ExportRow[] = [{ doc: { _id: "u1", email: "a@b.com", name: "Alice" }, table: "users" }];

        const result = await importShardRows(failingWriter, usersSchema, { rows });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "INSERT_FAILED", message: "Internal error" });

        freshDatabase.close();
    });
});

class ExportShardImpl extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override runShardExport(args: RunShardExportArgs): Promise<ExportRow[]> {
        const writer = createShardContextDatabase({ schema: usersSchema, sql: this.sql as never });
        const rows: ExportRow[] = [];

        return (async () => {
            for await (const row of exportShardRows(writer, usersSchema, args)) {
                rows.push(row);
            }

            return rows;
        })();
    }

    protected override async runShardImport(args: RunShardImportArgs) {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as never,
        });

        return importShardRows(writer, usersSchema, args);
    }
}

describe("shardDO admin export/import dispatch", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(async () => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        const writer = createShardContextDatabase({ schema: usersSchema, sql: database.sql });

        await writer.insert("users", { _id: "u1", email: "a@b.com", name: "Alice" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m1", channelId: "c1", text: "hi" }, { allowExplicitId: true });

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("dispatches exportShard and returns rows", async () => {
        expect.assertions(3);

        const shard = new ExportShardImpl(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.exportShard, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { rows: ExportRow[] } }>();

        expect(body.result.rows).toHaveLength(2);
        expect(body.result.rows.map((r) => r.table).toSorted((a, b) => a.localeCompare(b))).toEqual(["messages", "users"]);
    });

    it("dispatches importShard and inserts rows", async () => {
        expect.assertions(3);

        const shard = new ExportShardImpl(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(
            adminRequest(ADMIN_FUNCTIONS.importShard, {
                rows: [{ doc: { _id: "u2", email: "b@b.com", name: "Bob" }, table: "users" }],
            }),
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { errors: unknown[]; inserted: Record<string, number> } }>();

        expect(body.result.inserted).toEqual({ users: 1 });
        expect(body.result.errors).toEqual([]);
    });

    it("rejects without an admin token", async () => {
        expect.assertions(1);

        const shard = new ExportShardImpl(state, {});

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.exportShard, {}));

        expect(response.status).toBe(403);
    });
});
