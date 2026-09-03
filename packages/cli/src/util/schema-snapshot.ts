/**
 * Convert a {@link SchemaIR} from `@lunora/codegen` into a {@link SchemaSnapshot}
 * suitable for diffing against the persisted `.snapshot.json`.
 *
 * Only **D1-backed global** (`.global()`-marked) tables are persisted —
 * shard-local and root-DO tables live in per-DO SQLite, and
 * `.global({ backend: "hyperdrive" })` tables live in a Postgres/MySQL database
 * that provisions itself; neither needs a D1 migration.
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

/**
 * Is this table one the D1 migration generator owns?
 *
 * `.global()` alone is not the answer: `.global({ backend: "hyperdrive" })`
 * stores the table in a Postgres/MySQL database reached through Hyperdrive, and
 * that database provisions itself from the schema at runtime
 * (`runSqlGlobalTableMigrations`). Including it here emitted SQLite DDL —
 * double-quoted identifiers, `REAL` affinity — into a file the docs label "D1
 * SQL", which creates a phantom table if it is ever applied to D1 and is invalid
 * on MySQL. There is no dialect seam in the emitter (it renders through
 * `@lunora/d1/dialect` directly), so the honest answer is to leave those tables
 * out of the snapshot entirely.
 */
const isGlobal = (table: SchemaIR["tables"][number]): boolean => table.shardMode === "global" && table.globalBackend !== "hyperdrive";

const schemaIrToSnapshot = (ir: SchemaIR): SchemaSnapshot => {
    const tables: Record<string, TableSnapshot> = {};
    // The deploy gate's structural snapshot, built once from this same IR. Its
    // per-field shapes ride along in `ColumnSnapshot.field` so `migrate
    // generate` compares what `lunora prepare` compares, instead of a lossy
    // `{nullable, sqlType}` pair that cannot tell `v.string()` from `v.bigint()`.
    const structural = buildSchemaSnapshot(ir, []);

    for (const table of ir.tables) {
        if (!isGlobal(table)) {
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
