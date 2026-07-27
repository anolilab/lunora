/**
 * Turn an {@link IntrospectedDatabase} into authored TypeScript: a `defineSchema`
 * module and, optionally, a list/get procedure module per table.
 *
 * What this deliberately is NOT: a runtime gateway that serves an existing
 * database over HTTP. Lunora enforces auth and row-level security inside
 * procedures, so a table auto-published as CRUD would be a hole straight past
 * both. What `introspect` produces instead is a one-time scaffold the developer
 * owns from that moment on — the schema declaration they'd otherwise transcribe
 * by hand, plus procedures narrow enough to be safe to start from.
 *
 * Two rules shape the emitted procedures, both inherited from `defineListArgs`:
 * only columns an index can serve are published as filterable, and only indexed
 * columns (plus `_creationTime`) are sortable. That keeps the scaffold from
 * handing out a full-table scan on day one.
 */
import type { IntrospectedColumn, IntrospectedDatabase, IntrospectedTable, SqlDialect } from "./model";
import { RESERVED_COLUMNS, validatorForColumn } from "./model";

/** A file the command is about to write. */
interface EmittedFile {
    readonly contents: string;
    /** Path relative to the project's `lunora/` directory. */
    readonly path: string;
}

/** Everything the emitter produces, including what it had to leave behind. */
interface EmitResult {
    readonly files: ReadonlyArray<EmittedFile>;
    /** Human-readable notes (skipped columns, unmapped types) for the command to print. */
    readonly warnings: ReadonlyArray<string>;
}

interface EmitOptions {
    /** Emit `list`/`get` procedure modules alongside the schema. */
    readonly procedures: boolean;
    /** Import specifier for the server surface — `lunorash/server` or `@lunora/server`. */
    readonly serverImport: string;
}

const IDENTIFIER = /^[A-Z_$][\w$]*$/i;

/** Separator runs in a SQL identifier, consumed while camelCasing (`order_items` → `orderItems`). */
const SEPARATOR_RUN = /[^\dA-Z]+(.)?/gi;

/** A leading digit run, which can't start a JS identifier. */
const LEADING_DIGITS = /^\d+/;

/** Quote an object key when it isn't a bare JS identifier, so a `user-id` column still emits valid source. */
const key = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** Derive a valid TS export/const name from a table name (`order_items` → `orderItems`). */
const identifierFor = (name: string): string => {
    const camel = name.replaceAll(SEPARATOR_RUN, (_, next: string | undefined) => next?.toUpperCase() ?? "");
    const safe = camel.replace(LEADING_DIGITS, "");

    return safe === "" ? "table" : `${safe.charAt(0).toLowerCase()}${safe.slice(1)}`;
};

/** Columns Lunora can carry over, i.e. everything that doesn't collide with a system field. */
const usableColumns = (table: IntrospectedTable): IntrospectedColumn[] => table.columns.filter((column) => !RESERVED_COLUMNS.has(column.name));

/**
 * Columns that an index (or a foreign key) can serve, so they're safe to publish
 * as filterable. A composite index contributes all of its columns — the planner
 * can use a prefix, and a filter on a non-prefix column still narrows against the
 * index rather than scanning blind.
 */
const indexedColumns = (table: IntrospectedTable): string[] => {
    const names = new Set<string>(table.primaryKey);

    for (const index of table.indexes) {
        for (const column of index.columns) {
            names.add(column);
        }
    }

    for (const column of table.columns) {
        if (column.references !== undefined) {
            names.add(column.name);
        }
    }

    return [...names].filter((name) => !RESERVED_COLUMNS.has(name));
};

/** Emit the `defineTable({...})` body plus its chained `.global()` / `.index()` calls for one table. */
const tableSource = (table: IntrospectedTable, dialect: SqlDialect, warnings: string[]): string => {
    const lines: string[] = [];

    for (const column of table.columns) {
        if (RESERVED_COLUMNS.has(column.name)) {
            warnings.push(
                `${table.name}.${column.name}: skipped — \`${column.name}\` is a Lunora system column. Rename it in the source database or map it by hand.`,
            );

            continue;
        }

        const { expression, known } = validatorForColumn(column, dialect);

        if (!known && column.references === undefined) {
            warnings.push(`${table.name}.${column.name}: no mapping for SQL type \`${column.dataType}\` — emitted as \`v.any()\`.`);
            lines.push(`        // TODO: \`${column.dataType}\` has no direct validator; narrow this.`);
        }

        lines.push(`        ${key(column.name)}: ${expression},`);
    }

    const chain: string[] = [
        // The rows live in the external database, so the table is `.global()` on the
        // hyperdrive backend rather than sharded into a Durable Object.
        `        .global({ backend: "hyperdrive" })`,
    ];

    if (table.primaryKey.length > 0 && table.primaryKey.every((column) => !RESERVED_COLUMNS.has(column))) {
        // Lunora mints its own `_id`; the source primary key becomes a unique index
        // so the original identity is still enforced and still indexed.
        const columns = table.primaryKey.map((column) => `"${column}"`).join(", ");

        chain.push(`        .index("by_${table.primaryKey.join("_")}", [${columns}], { unique: true })`);
    }

    for (const index of table.indexes) {
        const columns = index.columns.filter((column) => !RESERVED_COLUMNS.has(column));

        if (columns.length === 0) {
            continue;
        }

        const rendered = columns.map((column) => `"${column}"`).join(", ");
        const options = index.unique ? ", { unique: true }" : "";

        chain.push(`        .index(${JSON.stringify(index.name)}, [${rendered}]${options})`);
    }

    return `    ${key(table.name)}: defineTable({\n${lines.join("\n")}\n    })\n${chain.join("\n")},`;
};

/** Emit the whole `schema.ts` module. */
const schemaSource = (database: IntrospectedDatabase, options: EmitOptions, warnings: string[]): string => {
    const tables = database.tables.map((table) => tableSource(table, database.dialect, warnings)).join("\n");

    return `/**
 * Generated by \`lunora introspect\` from an existing ${database.dialect === "postgres" ? "Postgres" : "MySQL"} database.
 *
 * This file is a STARTING POINT, not a build artifact — it is written once and is
 * yours to edit. Review it before shipping: column types are mapped
 * conservatively, and every table is \`.global({ backend: "hyperdrive" })\` because
 * its rows live in the external database. Re-running \`lunora introspect\` will not
 * overwrite it unless you pass \`--force\`.
 */
import { defineSchema, defineTable, v } from "${options.serverImport}";

export default defineSchema({
${tables}
});
`;
};

/**
 * Emit a `list` + `get` procedure module for one table. `list` is built on
 * `defineListArgs`, so it inherits keyset paging, the clamped limit, and the
 * enumerate-don't-open filter rule.
 *
 * Neither procedure is `.expose({ rest: true })`, and that is the point: publishing
 * is a decision the developer makes per endpoint, after they've added whatever
 * auth or RLS the table needs.
 */
const procedureSource = (table: IntrospectedTable, options: EmitOptions): string => {
    const name = identifierFor(table.name);
    const filterable = indexedColumns(table);
    const columns = new Map(usableColumns(table).map((column) => [column.name, column]));

    const filters = filterable
        .map((column) => {
            const definition = columns.get(column);

            if (definition === undefined) {
                return undefined;
            }

            // Filters are always matched against a concrete value, so drop the
            // `v.optional(...)` wrapper the column carries for nullability.
            const { expression } = validatorForColumn({ ...definition, nullable: false }, "postgres");

            return `        ${key(column)}: ${expression},`;
        })
        .filter((line) => line !== undefined);

    const sortable = ['"_creationTime"', ...filterable.map((column) => `"${column}"`)].join(", ");

    return `/**
 * Generated by \`lunora introspect\` for the \`${table.name}\` table — a starting
 * point you own and edit.
 *
 * Both procedures are RPC-only. Add \`.expose({ rest: true })\` once you've decided
 * this data should be public, and gate them with your auth/RLS middleware first —
 * \`introspect\` cannot know who is allowed to read this table.
 */
import { defineListArgs, v } from "${options.serverImport}";

import { c } from "./_generated/server";

const ${name}List = defineListArgs({
    // Only index-backed columns are published as filterable, so a caller cannot
    // force a full-table scan through the argument surface.
    filter: {
${filters.join("\n")}
    },
    orderBy: [${sortable}],
});

export const list = c.query.input(${name}List.args).query(({ args, ctx }) => ctx.db.${key(table.name)}.findMany(${name}List.toQueryArgs(args)));

export const get = c.query.input({ id: v.id("${table.name}") }).query(({ args, ctx }) => ctx.db.${key(table.name)}.get(args.id));
`;
};

/** Emit every file for an introspected database. */
const emitIntrospection = (database: IntrospectedDatabase, options: EmitOptions): EmitResult => {
    const warnings: string[] = [];
    const files: EmittedFile[] = [{ contents: schemaSource(database, options, warnings), path: "schema.ts" }];

    if (options.procedures) {
        for (const table of database.tables) {
            if (usableColumns(table).length === 0) {
                warnings.push(`${table.name}: no usable columns — procedure module skipped.`);

                continue;
            }

            files.push({ contents: procedureSource(table, options), path: `${table.name}.ts` });
        }
    }

    return { files, warnings };
};

export type { EmitOptions, EmitResult, EmittedFile };
export { emitIntrospection, identifierFor, indexedColumns, procedureSource, schemaSource };
