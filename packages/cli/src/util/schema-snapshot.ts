/**
 * Convert a {@link SchemaIR} from `@cirrus/codegen` into a {@link SchemaSnapshot}
 * suitable for diffing against the persisted `.snapshot.json`.
 *
 * Only **global** (`.global()`-marked) tables are persisted — shard-local and
 * root-DO tables live in per-DO SQLite and do not need D1 migrations.
 */
import type { SchemaIR, ValidatorIR } from "@cirrus/codegen";

import type { ColumnSnapshot, IndexSnapshot, SchemaSnapshot, TableSnapshot } from "./migration-diff.js";
import { validatorKindToSqlType } from "./migration-diff.js";

const validatorToColumn = (validator: ValidatorIR): ColumnSnapshot => {
    if (validator.kind === "optional" && validator.inner) {
        return {
            nullable: true,
            sqlType: validatorKindToSqlType(validator.inner.kind),
        };
    }

    return {
        nullable: false,
        sqlType: validatorKindToSqlType(validator.kind),
    };
};

const isGlobal = (mode: SchemaIR["tables"][number]["shardMode"]): boolean => mode === "global";

export const schemaIrToSnapshot = (ir: SchemaIR): SchemaSnapshot => {
    const tables: Record<string, TableSnapshot> = {};

    for (const table of ir.tables) {
        if (!isGlobal(table.shardMode)) {
            continue;
        }

        const columns: Record<string, ColumnSnapshot> = {};

        for (const [columnName, validator] of Object.entries(table.shape)) {
            columns[columnName] = validatorToColumn(validator);
        }

        const indexes: Record<string, IndexSnapshot> = {};

        for (const index of table.indexes) {
            indexes[index.name] = {
                fields: [...index.fields],
                name: index.name,
                unique: index.unique ?? false,
            };
        }

        tables[table.name] = {
            columns,
            indexes,
            name: table.name,
        };
    }

    return { tables, version: 1 };
};
