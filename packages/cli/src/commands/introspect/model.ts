/**
 * The dialect-neutral model `lunora introspect` builds from an existing
 * Postgres/MySQL database, plus the mapping from a native SQL type onto a `v.*`
 * validator.
 *
 * This is deliberately a SCAFFOLD model, not a runtime binding. `lunora
 * introspect` reads someone else's database once and writes TypeScript the
 * developer then owns and edits — so every mapping here errs toward "widest thing
 * that round-trips" (an unrecognised type becomes `v.any()` with a TODO) rather
 * than failing the run. Getting a schema file the developer can immediately
 * `lunora dev` against matters more than being exhaustive on exotic types.
 */

/** The SQL engines introspection can read. Matches `@lunora/sql-store`'s dialect names. */
type SqlDialect = "mysql" | "postgres";

/** One column of an introspected table. `dataType` is the raw, lower-cased native type name. */
interface IntrospectedColumn {
    /** Nesting depth for array types (Postgres `text[]` → 1). `0` for a scalar. */
    readonly arrayDepth: number;
    readonly dataType: string;
    readonly name: string;
    readonly nullable: boolean;
    /** Target of this column's foreign key, when it has one. */
    readonly references?: { readonly column: string; readonly table: string };
}

/** A secondary index carried over as a `.index(...)` declaration. */
interface IntrospectedIndex {
    readonly columns: ReadonlyArray<string>;
    readonly name: string;
    readonly unique: boolean;
}

interface IntrospectedTable {
    readonly columns: ReadonlyArray<IntrospectedColumn>;
    readonly indexes: ReadonlyArray<IntrospectedIndex>;
    readonly name: string;
    readonly primaryKey: ReadonlyArray<string>;
}

interface IntrospectedDatabase {
    readonly dialect: SqlDialect;
    readonly tables: ReadonlyArray<IntrospectedTable>;
}

/**
 * Column names Lunora owns on every row. A source column colliding with one of
 * these can't be carried over verbatim — the emitter drops it and reports it, so
 * the developer decides on a rename rather than getting a schema that silently
 * shadows a system field.
 */
const RESERVED_COLUMNS = new Set(["_creationTime", "_id"]);

/** Postgres native types → `v.*` factory call, keyed by the lower-cased `udt_name`/`data_type`. */
const POSTGRES_TYPES: Record<string, string> = {
    bigint: "v.bigint()",
    bigserial: "v.bigint()",
    bit: "v.string()",
    bool: "v.boolean()",
    boolean: "v.boolean()",
    box: "v.string()",
    bpchar: "v.string()",
    bytea: "v.bytes()",
    char: "v.string()",
    character: "v.string()",
    "character varying": "v.string()",
    cidr: "v.string()",
    circle: "v.string()",
    citext: "v.string()",
    date: "v.date()",
    "double precision": "v.number()",
    float4: "v.number()",
    float8: "v.number()",
    inet: "v.string()",
    int: "v.number()",
    int2: "v.number()",
    int4: "v.number()",
    int8: "v.bigint()",
    integer: "v.number()",
    interval: "v.string()",
    json: "v.any()",
    jsonb: "v.any()",
    line: "v.string()",
    lseg: "v.string()",
    macaddr: "v.string()",
    money: "v.number()",
    name: "v.string()",
    numeric: "v.number()",
    path: "v.string()",
    point: "v.string()",
    polygon: "v.string()",
    real: "v.number()",
    serial: "v.number()",
    smallint: "v.number()",
    smallserial: "v.number()",
    text: "v.string()",
    time: "v.string()",
    "time with time zone": "v.string()",
    "time without time zone": "v.string()",
    timestamp: "v.timestamp()",
    "timestamp with time zone": "v.timestamp()",
    "timestamp without time zone": "v.timestamp()",
    timestamptz: "v.timestamp()",
    tsquery: "v.string()",
    tsvector: "v.string()",
    uuid: "v.string()",
    varbit: "v.string()",
    varchar: "v.string()",
    xml: "v.string()",
};

/** MySQL native types → `v.*` factory call, keyed by the lower-cased `DATA_TYPE`. */
const MYSQL_TYPES: Record<string, string> = {
    bigint: "v.bigint()",
    binary: "v.bytes()",
    bit: "v.number()",
    blob: "v.bytes()",
    char: "v.string()",
    date: "v.date()",
    datetime: "v.timestamp()",
    decimal: "v.number()",
    double: "v.number()",
    enum: "v.string()",
    float: "v.number()",
    int: "v.number()",
    integer: "v.number()",
    json: "v.any()",
    longblob: "v.bytes()",
    longtext: "v.string()",
    mediumblob: "v.bytes()",
    mediumint: "v.number()",
    mediumtext: "v.string()",
    numeric: "v.number()",
    set: "v.string()",
    smallint: "v.number()",
    text: "v.string()",
    time: "v.string()",
    timestamp: "v.timestamp()",
    tinyblob: "v.bytes()",
    tinyint: "v.number()",
    tinytext: "v.string()",
    varbinary: "v.bytes()",
    varchar: "v.string()",
    year: "v.number()",
};

/**
 * Map one column onto the `v.*` expression that represents it, including array
 * nesting and nullability. A foreign key becomes `v.id("&lt;target table>")` so the
 * generated schema states the relationship in Lunora's own vocabulary instead of
 * leaving a bare string.
 *
 * Returns the expression plus `known: false` when the native type had no mapping
 * — the caller turns that into a `TODO` comment beside the column rather than
 * guessing silently.
 */
const validatorForColumn = (column: IntrospectedColumn, dialect: SqlDialect): { expression: string; known: boolean } => {
    const table = dialect === "postgres" ? POSTGRES_TYPES : MYSQL_TYPES;
    const mapped = table[column.dataType];
    // An FK is expressed as a branded id so the relationship survives into the
    // generated types; the underlying column stays a string/number in the database.
    // The target name is a catalog identifier, so it is emitted as a JSON-escaped
    // literal — a name containing `"` or `\` would otherwise break out of the
    // string and inject code into the schema the developer later runs.
    const base = column.references === undefined ? mapped : `v.id(${JSON.stringify(column.references.table)})`;

    let expression = base ?? "v.any()";

    for (let depth = 0; depth < column.arrayDepth; depth += 1) {
        expression = `v.array(${expression})`;
    }

    if (column.nullable) {
        expression = `v.optional(${expression})`;
    }

    return { expression, known: base !== undefined };
};

export type { IntrospectedColumn, IntrospectedDatabase, IntrospectedIndex, IntrospectedTable, SqlDialect };
export { MYSQL_TYPES, POSTGRES_TYPES, RESERVED_COLUMNS, validatorForColumn };
