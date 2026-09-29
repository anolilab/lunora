import type { IndexIR, SchemaIR, TableIR, ValidatorIR } from "../ir";
import { SCHEMA_MODULE_PATH } from "./data-model";
import { rebaseRelativeQualifiers } from "./qualifiers";
import { assertIdentifier, baseSpecifiers, GENERATED_HEADER, renderObjectKey, unwrapOptional, validatorToType } from "./shared";

// ─── Drizzle schema emission ─────────────────────────────────────────────────

interface DrizzleColumn {
    /** Drizzle column constructor: "text" | "integer" | "real" | "blob". */
    builder: "blob" | "integer" | "real" | "text";
    /** Optional `{ mode: … }` arg to the column constructor. */
    mode?: "bigint" | "boolean" | "buffer" | "json";
    /** Tracks whether the column should carry `.notNull()`. */
    notNull: boolean;
    /** `.$type<…>()` annotation rendered after the constructor. */
    typeAnnotation?: string;
}

const validatorToDrizzleColumn = (validator: ValidatorIR): DrizzleColumn => {
    switch (validator.kind) {
        case "array":
        case "object":
        case "record":
        case "union": {
            return {
                builder: "text",
                mode: "json",
                notNull: true,
                typeAnnotation: validatorToType(validator),
            };
        }
        case "bigint": {
            return { builder: "blob", mode: "bigint", notNull: true };
        }
        case "boolean": {
            return { builder: "integer", mode: "boolean", notNull: true };
        }
        case "bytes": {
            return { builder: "blob", mode: "buffer", notNull: true };
        }
        case "date":
        case "timestamp": {
            // Stored as epoch-millisecond integers.
            return { builder: "integer", notNull: true };
        }
        case "from": {
            // Plain text, NOT the `mode: "json"` group above — matching how the
            // value actually round-trips. `sqliteEncode` keys off the runtime JS
            // type, so a `v.from(z.string())` column holds a bare `hello`, and
            // drizzle's json mode would `JSON.parse` that and throw on every read.
            // The `$type<…>()` annotation still carries the type recovered from
            // `~standard.types.output`, so `Doc_*` sees the real shape.
            return { builder: "text", notNull: true, typeAnnotation: validatorToType(validator) };
        }
        case "id": {
            return { builder: "text", notNull: true };
        }
        case "literal": {
            const value = validator.literalValue ?? "";

            // String literals start with a quote; `true`/`false`/`null` are plain
            // keywords; everything else is numeric.
            if (value.startsWith('"') || value.startsWith("'")) {
                return { builder: "text", notNull: true };
            }

            if (value === "true" || value === "false") {
                return { builder: "integer", mode: "boolean", notNull: true };
            }

            if (value === "null") {
                return { builder: "text", notNull: true };
            }

            return { builder: "real", notNull: true };
        }
        case "null": {
            return { builder: "text", notNull: true };
        }
        case "number": {
            return { builder: "real", notNull: true };
        }
        case "optional": {
            const inner = validator.inner ? validatorToDrizzleColumn(validator.inner) : { builder: "text" as const, notNull: false };

            return { ...inner, notNull: false };
        }
        case "storage":
        case "string": {
            return { builder: "text", notNull: true };
        }
        default: {
            return { builder: "text", notNull: true };
        }
    }
};

/**
 * The FK target for a column, or `undefined` when it is not one.
 *
 * `v.id("targetTable")` becomes a FK only when the target lives in the same
 * bucket — cross-bucket FKs can't be enforced (different SQLite databases).
 * Shared by the renderer and the import scan so the two cannot disagree about
 * which columns emit a `.references(...)`.
 */
const referencedTable = (validator: ValidatorIR, knownTables: ReadonlySet<string>): string | undefined => {
    const inner = unwrapOptional(validator);

    return inner.kind === "id" && inner.tableName !== undefined && knownTables.has(inner.tableName) ? inner.tableName : undefined;
};

const renderDrizzleColumn = (name: string, validator: ValidatorIR, knownTables: ReadonlySet<string>): string => {
    // The column name is emitted as a bare object key (`<name>: …`) and a
    // `builder("<name>")` literal, so it must be a valid identifier like the
    // table/index names — reject unescaped source at the same boundary.
    assertIdentifier(name, "drizzle column name");

    const column = validatorToDrizzleColumn(validator);

    const modeArgument = column.mode ? `, { mode: "${column.mode}" }` : "";
    let expression = `${column.builder}("${name}"${modeArgument})`;

    if (column.typeAnnotation) {
        expression += `.$type<${column.typeAnnotation}>()`;
    }

    const fkTable = referencedTable(validator, knownTables);

    // The `(): AnySQLiteColumn` return annotation is drizzle's documented
    // workaround for self-references: a table whose column references its own
    // binding is circular in its own initializer, and TypeScript cannot infer
    // through that under `noImplicitAny` (TS7022 on the binding, TS7024 on the
    // callback). Annotating breaks the cycle. It is emitted unconditionally
    // rather than only for statically-detected self-references — it is a no-op
    // on ordinary FKs, and mutual cycles (a -> b -> a) need it just as much.
    if (fkTable !== undefined) {
        expression += `.references((): AnySQLiteColumn => ${fkTable}._id)`;
    }

    // `.nullable()` is recorded on the column meta rather than as its own kind,
    // so the kind-based mapping above cannot see it.
    if (column.notNull && validator.column?.notNull !== false) {
        expression += ".notNull()";
    }

    return expression;
};

const renderIndexEntry = (index: IndexIR): string => {
    // An index NAME may legitimately be a non-identifier — `emitDataModel` says so
    // and emits `"by-author"` into its union, and `.searchIndex("search-body")`
    // ships today. This renderer used to `assertIdentifier` it, so `.index("by-author")`
    // died with an INTERNAL error naming no file and no line while its sibling
    // index kinds accepted the same spelling. Render it safely instead: a quoted
    // object key and a JSON-escaped literal, which is what closes the injection
    // vector without rejecting a hyphen.
    //
    // Each FIELD stays asserted — it is spliced as a bare `t.<field>` column
    // accessor, where there is nothing to quote. `assertTopLevelIndexField` gives
    // the nested-path case a located diagnostic upstream; this remains the
    // backstop for anything that reaches here another way.
    const constructor = index.unique ? "uniqueIndex" : "index";
    const fields = index.fields
        .map((field) => {
            assertIdentifier(field, "drizzle index field");

            return `t.${field}`;
        })
        .join(", ");

    return `    ${renderObjectKey(index.name)}: ${constructor}(${JSON.stringify(index.name)}).on(${fields}),`;
};

const renderDrizzleTable = (table: TableIR, knownTables: ReadonlySet<string>): string => {
    // `table.name` is emitted as a bare `export const <name>` binding and a
    // `sqliteTable("<name>")` literal, so the Drizzle emitter validates it too
    // rather than relying on an upstream caller having done so.
    assertIdentifier(table.name, "table name");

    const columns = [
        `    _id: text("_id").primaryKey(),`,
        `    _creationTime: integer("_creationTime").notNull(),`,
        ...Object.entries(table.shape).map(([fieldName, validator]) => `    ${fieldName}: ${renderDrizzleColumn(fieldName, validator, knownTables)},`),
    ].join("\n");

    const indexBody = table.indexes.length > 0 ? `, (t) => ({\n${table.indexes.map((index) => renderIndexEntry(index)).join("\n")}\n})` : "";

    return `export const ${table.name} = sqliteTable("${table.name}", {\n${columns}\n}${indexBody});`;
};

interface DrizzleImports {
    /** Value imports: column + table constructors from the drizzle subpath. */
    columns: string[];
    /** Value imports: `index` / `uniqueIndex`, only when the file declares indexes. */
    indexes: string[];
    /** True when any column emits a `.references()` FK, which is return-annotated. */
    needsAnyColumn: boolean;
    /** True when any `.$type<…>()` annotation spells an `Id<"table">`. */
    needsId: boolean;
}

/**
 * `.$type<…>()` inlines the rendered TS type, and `validatorToType` spells a
 * nested `v.id()` as `Id<"table">` — so a `v.object` / `v.union` column
 * carrying an id makes the file reference `Id` even though no column is an id
 * at the top level.
 */
const annotationNeedsId = (column: DrizzleColumn): boolean => column.typeAnnotation?.includes('Id<"') ?? false;

const usedImports = (tables: ReadonlyArray<TableIR>, knownTables: ReadonlySet<string>): DrizzleImports => {
    // `sqliteTable` is always needed. `_id` is always text, `_creationTime` is always integer.
    const columns = new Set<string>(["integer", "sqliteTable", "text"]);
    const indexes = new Set<string>();
    let needsAnyColumn = false;
    let needsId = false;

    for (const table of tables) {
        for (const validator of Object.values(table.shape)) {
            const column = validatorToDrizzleColumn(validator);

            columns.add(column.builder);
            needsId = needsId || annotationNeedsId(column);
            needsAnyColumn = needsAnyColumn || referencedTable(validator, knownTables) !== undefined;
        }

        for (const index of table.indexes) {
            indexes.add(index.unique ? "uniqueIndex" : "index");
        }
    }

    return {
        columns: [...columns].toSorted((a, b) => a.localeCompare(b)),
        indexes: [...indexes].toSorted((a, b) => a.localeCompare(b)),
        needsAnyColumn,
        needsId,
    };
};

const renderDrizzleFile = (tables: ReadonlyArray<TableIR>, useUmbrella = false): string => {
    if (tables.length === 0) {
        return `${GENERATED_HEADER}export {};\n`;
    }

    const base = baseSpecifiers(useUmbrella);
    const knownTables = new Set(tables.map((table) => table.name));
    const { columns, indexes, needsAnyColumn, needsId } = usedImports(tables, knownTables);
    const importParts = [...indexes, ...columns].toSorted((a, b) => a.localeCompare(b));

    const tableBlocks = tables.map((table) => renderDrizzleTable(table, knownTables)).join("\n\n");

    // Both are type-only and therefore erased at compile time — the `Id` import
    // back into `dataModel.ts` creates no runtime cycle even though the data
    // model is itself derived from these tables.
    const typeImports = [
        needsAnyColumn ? `import type { AnySQLiteColumn } from "${base.serverDrizzle}";\n` : "",
        needsId ? `import type { Id } from "./dataModel.js";\n` : "",
    ].join("");

    return `${GENERATED_HEADER}import { ${importParts.join(", ")} } from "${base.serverDrizzle}";
${typeImports}
${tableBlocks}
`;
};

/**
 * Emit drizzle `sqliteTable` definitions for the project schema, split into
 * `global` (D1-backed) and `shard` (DO-SQLite-backed) buckets. Tables marked
 * `.global()` go in the global file; everything else (default root + `.shardBy()`)
 * goes in the shard file.
 *
 * `searchIndexes` are intentionally not emitted — drizzle has no `sqliteTable`
 * abstraction for FTS5 virtual tables. FTS plumbing is handled by the runtime
 * outside of drizzle.
 */
const emitDrizzleSchema = (schema: SchemaIR, useUmbrella = false): { global: string; shard: string } => {
    const globalTables = schema.tables.filter((table) => table.shardMode === "global");
    const shardTables = schema.tables.filter((table) => table.shardMode !== "global");

    // Rebased for the same reason `emitDataModel` is: a `v.from()` column's
    // `$type<…>()` annotation can carry a qualifier relative to `schema.ts`, and
    // `drizzle.*.ts` sits one directory deeper.
    return {
        global: rebaseRelativeQualifiers(renderDrizzleFile(globalTables, useUmbrella), SCHEMA_MODULE_PATH),
        shard: rebaseRelativeQualifiers(renderDrizzleFile(shardTables, useUmbrella), SCHEMA_MODULE_PATH),
    };
};

export default emitDrizzleSchema;
