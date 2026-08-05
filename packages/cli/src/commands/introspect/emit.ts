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
 * columns (plus `_creationTime`) are sortable. That bounds which columns a caller
 * can reach — though not the cost of every operator over them, since `contains`
 * and the negative operators are non-sargable whatever the column.
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

/**
 * Characters that may appear in an emitted filename; everything else — including
 * `.`, so no `..` segment can survive — is folded to `_`.
 */
const PATH_UNSAFE = /[^\w-]/g;

/**
 * Characters `JSON.stringify` leaves raw that are still unsafe once the emitted
 * source travels: `<` / `>` / `/` can close a host `</script>` if the file is
 * ever inlined into HTML (a code viewer, a docs page), and U+2028 / U+2029 are
 * line terminators that older tooling treats as breaking the literal. Their
 * escaped forms denote the identical string, so this costs nothing.
 */
const LITERAL_UNSAFE = /[\u003C\u003E\u002F\u2028\u2029]/g;

const LITERAL_UNSAFE_ESCAPES: Readonly<Record<string, string>> = {
    "\u002F": String.raw`\u002F`,
    "\u2028": String.raw`\u2028`,
    "\u2029": String.raw`\u2029`,
    "\u003C": String.raw`\u003C`,
    "\u003E": String.raw`\u003E`,
};

/**
 * Emit `value` as a TypeScript string literal.
 *
 * EVERY identifier read out of the source database must go through this. Table,
 * column, and index names are attacker-adjacent input — they're legal to quote in
 * both Postgres and MySQL, so they can contain `"`, `\`, or a newline — and the
 * output of this emitter is TypeScript the developer subsequently runs. Splicing
 * a raw name into a quoted literal is a code-injection hole, not a cosmetic bug.
 *
 * `JSON.stringify` handles quotes, backslashes, and control characters;
 * {@link LITERAL_UNSAFE} covers the rest, so the result is safe both as TypeScript
 * and in any downstream context the generated file gets embedded in.
 */
const literal = (value: string): string => JSON.stringify(value).replaceAll(LITERAL_UNSAFE, (character) => LITERAL_UNSAFE_ESCAPES[character] ?? character);

/** Quote an object key when it isn't a bare JS identifier, so a `user-id` column still emits valid source. */
const key = (name: string): string => (IDENTIFIER.test(name) ? name : literal(name));

/**
 * Emit a property access for `name`: `.orders` for a bare identifier, but
 * `["order-items"]` otherwise. Dot notation with a quoted key is a syntax error,
 * so this cannot just reuse {@link key}.
 */
const member = (name: string): string => (IDENTIFIER.test(name) ? `.${name}` : `[${literal(name)}]`);

/**
 * Neutralize a value interpolated into an emitted block comment. A name
 * containing a comment terminator would otherwise close the comment early and let
 * the rest of the name land in code position.
 */
const comment = (text: string): string => text.replaceAll("*/", String.raw`*\/`);

/**
 * Fold a table name into a safe single filename segment. A name is free to
 * contain `/` or `..`, which would otherwise escape the output directory once
 * joined — introspection must never write outside `lunora/`.
 */
const fileSegment = (name: string): string => {
    const safe = name.replaceAll(PATH_UNSAFE, "_");

    return safe === "" ? "table" : safe;
};

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

/**
 * Resolve a column against the set of tables actually being emitted. A foreign
 * key can point somewhere that isn't in the output — `--tables` selected a
 * subset, or the FK crosses into another schema — and `v.id("absent")` would not
 * resolve, so the whole generated schema would fail to type-check. Demote such a
 * column to its plain scalar type instead and report it: a schema that compiles
 * with one weaker column beats one that doesn't compile at all.
 */
const resolveReference = (column: IntrospectedColumn, present: ReadonlySet<string>, table: string, warnings: string[]): IntrospectedColumn => {
    if (column.references === undefined || present.has(column.references.table)) {
        return column;
    }

    warnings.push(
        `${table}.${column.name}: references \`${column.references.table}\`, which isn't in the generated schema — emitted as a plain column instead of \`v.id(...)\`.`,
    );

    // Rebuilt field-by-field rather than rest-destructured: `references` is the
    // one property being dropped, and naming it explicitly keeps that visible.
    return { arrayDepth: column.arrayDepth, dataType: column.dataType, name: column.name, nullable: column.nullable };
};

/** Emit the `defineTable({...})` body plus its chained `.global()` / `.index()` calls for one table. */
const tableSource = (table: IntrospectedTable, dialect: SqlDialect, present: ReadonlySet<string>, warnings: string[]): string => {
    const lines: string[] = [];

    for (const column of table.columns) {
        if (RESERVED_COLUMNS.has(column.name)) {
            warnings.push(
                `${table.name}.${column.name}: skipped — \`${column.name}\` is a Lunora system column. Rename it in the source database or map it by hand.`,
            );

            continue;
        }

        const resolved = resolveReference(column, present, table.name, warnings);
        const { expression, known } = validatorForColumn(resolved, dialect);

        if (!known && resolved.references === undefined) {
            warnings.push(`${table.name}.${column.name}: no mapping for SQL type \`${column.dataType}\` — emitted as \`v.any()\`.`);
            // A line comment, so only a newline could break out — and `dataType`
            // comes from a single `information_schema` type column, which can't
            // contain one. Still routed through `comment` for uniformity.
            lines.push(`        // TODO: \`${comment(column.dataType)}\` has no direct validator; narrow this.`);
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
        const columns = table.primaryKey.map((column) => literal(column)).join(", ");

        chain.push(`        .index(${literal(`by_${table.primaryKey.join("_")}`)}, [${columns}], { unique: true })`);
    }

    for (const index of table.indexes) {
        const columns = index.columns.filter((column) => !RESERVED_COLUMNS.has(column));

        if (columns.length === 0) {
            continue;
        }

        const rendered = columns.map((column) => literal(column)).join(", ");
        const options = index.unique ? ", { unique: true }" : "";

        chain.push(`        .index(${literal(index.name)}, [${rendered}]${options})`);
    }

    return `    ${key(table.name)}: defineTable({\n${lines.join("\n")}\n    })\n${chain.join("\n")},`;
};

/** Emit the whole `schema.ts` module. */
const schemaSource = (database: IntrospectedDatabase, options: EmitOptions, warnings: string[]): string => {
    const present = new Set(database.tables.map((table) => table.name));
    const tables = database.tables.map((table) => tableSource(table, database.dialect, present, warnings)).join("\n");

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
const procedureSource = (
    table: IntrospectedTable,
    dialect: SqlDialect,
    options: EmitOptions,
    present: ReadonlySet<string> = new Set([table.name]),
    warnings: string[] = [],
): string => {
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
            const resolved = resolveReference({ ...definition, nullable: false }, present, table.name, []);
            const { expression, known } = validatorForColumn(resolved, dialect);

            if (!known && resolved.references === undefined) {
                warnings.push(`${table.name}.${column}: filter falls back to \`v.any()\` (no mapping for SQL type \`${definition.dataType}\`).`);
            }

            return `        ${key(column)}: ${expression},`;
        })
        .filter((line) => line !== undefined);

    const sortable = [literal("_creationTime"), ...filterable.map((column) => literal(column))].join(", ");
    const accessor = `ctx.db${member(table.name)}`;

    return `/**
 * Generated by \`lunora introspect\` for the \`${comment(table.name)}\` table — a
 * starting point you own and edit.
 *
 * Both procedures are RPC-only. Add \`.expose({ rest: true })\` once you've decided
 * this data should be public, and gate them with your auth/RLS middleware first —
 * \`introspect\` cannot know who is allowed to read this table.
 */
import { defineListArgs, v } from "${options.serverImport}";

import type { Doc } from "./_generated/dataModel";
import { c } from "./_generated/server";

const ${name}List = defineListArgs<Doc<${literal(table.name)}>>()({
    // Only index-backed columns are published as filterable, so a caller cannot
    // reach a column you did not choose to expose. Note that \`contains\` and the
    // negative operators still scan — narrow this list, and review it, before
    // adding \`.expose({ rest: true })\`.
    filter: {
${filters.join("\n")}
    },
    orderBy: [${sortable}],
});

export const list = c.query.input(${name}List.args).query(({ args, ctx }) => ${accessor}.findMany(${name}List.toQueryArgs(args)));

export const get = c.query.input({ id: v.id(${literal(table.name)}) }).query(({ args, ctx }) => ${accessor}.get(args.id));
`;
};

/** Emit every file for an introspected database. */
const emitIntrospection = (database: IntrospectedDatabase, options: EmitOptions): EmitResult => {
    const warnings: string[] = [];
    const present = new Set(database.tables.map((table) => table.name));
    const files: EmittedFile[] = [{ contents: schemaSource(database, options, warnings), path: "schema.ts" }];

    if (options.procedures) {
        // Pre-seeded with the schema module's own name: a table literally called
        // `schema` would otherwise mint a second `schema.ts`, and `--force` would
        // overwrite the generated schema with a procedure module.
        const claimed = new Map<string, string>([["schema", "the generated schema module"]]);

        for (const table of database.tables) {
            if (usableColumns(table).length === 0) {
                warnings.push(`${table.name}: no usable columns — procedure module skipped.`);

                continue;
            }

            const segment = fileSegment(table.name);

            if (segment !== table.name) {
                warnings.push(`${table.name}: written as \`${segment}.ts\` — the table name isn't usable as a filename.`);
            }

            // Two source names can fold onto one filename (`a-b` and `a.b` both
            // become `a_b`). Silently overwriting the first would lose a table, so
            // skip and say which pair collided.
            const previous = claimed.get(segment);

            if (previous !== undefined) {
                warnings.push(`${table.name}: procedure module skipped — its filename \`${segment}.ts\` collides with table \`${previous}\`.`);

                continue;
            }

            claimed.set(segment, table.name);
            files.push({ contents: procedureSource(table, database.dialect, options, present, warnings), path: `${segment}.ts` });
        }
    }

    return { files, warnings };
};

export type { EmitOptions, EmitResult, EmittedFile };
export { emitIntrospection, identifierFor, indexedColumns };
