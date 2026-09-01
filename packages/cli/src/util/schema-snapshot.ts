/**
 * Convert a {@link SchemaIR} from `@lunora/codegen` into a {@link SchemaSnapshot}
 * suitable for diffing against the persisted `.snapshot.json`.
 *
 * Only **global** (`.global()`-marked) tables are persisted — shard-local and
 * root-DO tables live in per-DO SQLite and do not need D1 migrations.
 */
import type { SchemaIR, ValidatorIR } from "@lunora/codegen";
import { buildSchemaSnapshot } from "@lunora/codegen";

import type { ColumnSnapshot, IndexSnapshot, SchemaSnapshot, TableSnapshot } from "./migration-diff";
import { validatorKindToSqlType } from "./migration-diff";

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

const schemaIrToSnapshot = (ir: SchemaIR): SchemaSnapshot => {
    const tables: Record<string, TableSnapshot> = {};
    // The deploy gate's structural snapshot, built once from this same IR. Its
    // per-field shapes ride along in `ColumnSnapshot.field` so `migrate
    // generate` compares what `lunora prepare` compares, instead of a lossy
    // `{nullable, sqlType}` pair that cannot tell `v.string()` from `v.bigint()`.
    const structural = buildSchemaSnapshot(ir, []);

    for (const table of ir.tables) {
        if (!isGlobal(table.shardMode)) {
            continue;
        }

        const columns: Record<string, ColumnSnapshot> = {};

        for (const [columnName, validator] of Object.entries(table.shape)) {
            const field = structural.tables[table.name]?.fields[columnName];

            columns[columnName] = field === undefined ? validatorToColumn(validator) : { ...validatorToColumn(validator), field };
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

export default schemaIrToSnapshot;
