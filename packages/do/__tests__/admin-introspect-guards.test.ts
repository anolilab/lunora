import type { ColumnMeta, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBulkDeleteArgs } from "../src/admin-rpc-args";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

describe("deleteRows predicate guard", () => {
    it.each([
        { filters: [{ column: "title", operator: "contains", value: "" }] },
        { filters: [{ column: "title", operator: "contains" }] },
        { filters: [{ column: "title", operator: "contains", value: {} }] },
        { filters: [{ column: "title", operator: "gte", value: "" }] },
        { filters: [{ column: "title", operator: "lt", value: "" }] },
    ])("refuses a predicate that constrains nothing: %j", (args) => {
        expect.assertions(1);

        expect(() => parseBulkDeleteArgs({ ...args, table: "posts" })).toThrow(/a predicate .* is required/u);
    });

    it("keeps a real clause next to a dropped one", () => {
        expect.assertions(1);

        const parsed = parseBulkDeleteArgs({
            filters: [
                { column: "title", operator: "contains", value: "" },
                { column: "title", operator: "eq", value: "" },
            ],
            table: "posts",
        });

        expect(parsed.filters).toStrictEqual([{ column: "title", operator: "eq", value: "" }]);
    });
});

describe("replica bootstrap row count", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("counts only the schema's user rows, not the CDC log, index companions or stray tables", async () => {
        expect.assertions(1);

        const schema = {
            tables: {
                notes: {
                    indexes: [],
                    rankIndexes: [{ name: "byN", on: "notes", partitionBy: [], sortBy: [{ direction: "asc", field: "n" }] }],
                    shape: { n: { kind: "number" } },
                },
            },
        } as unknown as SchemaLike;

        runShardMigrations(database.sql, schema, { cdc: true });

        const writer = createShardContextDatabase({ cdc: true, clock: () => 1, schema, sql: database.sql });

        for (let index = 0; index < 10; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential fixture writes
            const id = await writer.insert("notes", { n: index });

            // eslint-disable-next-line no-await-in-loop -- sequential fixture writes
            await writer.patch(id, { n: -index }, "notes");
        }

        // A non-schema table the shard also holds (a component's own storage, say):
        // the export does not ship it, so the bootstrap cap must not count it.
        database.sql.exec("CREATE TABLE stray (id TEXT PRIMARY KEY)");
        database.sql.exec("INSERT INTO stray VALUES ('a'), ('b')");

        class SchemaShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; never dispatched
            public override async handleRpc(): Promise<unknown> {
                return null;
            }

            // eslint-disable-next-line class-methods-use-this -- schema-derived hook, as the codegen subclass emits it
            protected override tableColumns(table: string): ColumnMeta[] {
                return table === "notes" ? [{ name: "_id", optional: false, pk: true, type: "id" }] : [];
            }
        }

        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
        const shard = new SchemaShard(state, {});
        const host = (shard as unknown as { replicaOwnerHost: { rowCount: () => number } }).replicaOwnerHost;

        expect(host.rowCount()).toBe(10);
    });
});
