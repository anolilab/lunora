import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";

import type { BoundedTarget } from "../../../shard-engine/__tests__/_helpers/bounded-find-many";
import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

/**
 * The SQL store's side of the shared bounded-`findMany` contract: a `.global()` table whose
 * nullable `score` column holds SQL NULL. Runtime-neutral, so the node and the D1 suites share it.
 */
const boundedSchema = (table: string): SchemaLike => {
    const column = (kind: string, notNull: boolean): ValidatorLike => {
        return { _meta: { column: { notNull } }, kind };
    };

    return {
        tables: {
            [table]: {
                indexes: [],
                shape: { group: column("string", true), label: column("string", true), score: column("number", false), seq: column("number", true) },
                shardMode: { kind: "global" },
            },
        },
    } as never;
};

const openBoundedTarget = (dialect: SqlDialect, exec: SqlCtxExec, table: string): BoundedTarget => {
    // One instant for every row, so the order keys tie on `_creationTime` and only the id splits a tie.
    const writer = createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect, exec, schema: boundedSchema(table) });

    return {
        findMany: async (args) => writer.findMany(table, args),
        insert: async (document) => writer.insert(table, document),
    };
};

export default openBoundedTarget;
