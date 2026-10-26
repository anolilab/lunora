import type { Expression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { globalTtlMessage } from "../../../../../../shared/global-ttl";
import { isInternalTableName } from "../../../../../../shared/internal-table-name";
import { diagnosticAt } from "../../../diagnostics";
import type {
    ExternalSourceIR,
    GeoIndexIR,
    IndexIR,
    KeyedRelationIR,
    RankIndexIR,
    RankSortKeyIR,
    RelationIR,
    SearchIndexIR,
    TableIR,
    TtlIR,
    ValidatorIR,
    VectorIndexIR,
} from "../../../ir";
import { parseObjectShape, resolveObjectLiteral } from "../../../parse-validator";
import { RESERVED_JS_WORDS } from "../../../reserved-words";
import { findObjectProperty, propertyKeyName } from "../../ast";
import { asMetric, getBooleanProperty, getNumberProperty, getStringArrayProperty, getStringProperty, indexNameOf, stringArrayPropertyOf } from "./properties";

const ON_DELETE_ACTIONS = new Set(["cascade", "restrict", "set null"]);

/**
 * Every member of `@lunora/shard-engine`'s `DatabaseWriterLike` — the writer the
 * generated `_generated/shard.ts` widens with the per-table facade.
 *
 * The facade is assigned onto the writer ITSELF
 * (`facade[<table>] = bindTableFacade(db, <table>)`), so a table whose name
 * matches a member replaces that method with a `FacadeEntry` at runtime: every
 * flat `ctx.db.<member>(...)` call then throws "is not a function". Codegen
 * rejects such a name up front instead.
 *
 * The list is restated here rather than derived, because codegen must not take a
 * runtime dependency on the engine (and interface members are erased anyway).
 * `__tests__/discover/reserved-table-names.test.ts` parses `DatabaseWriterLike`
 * from source and fails when the two diverge — the drift is the thing gated, and
 * it went unnoticed long enough for twenty-plus members to accumulate unguarded.
 */
const RESERVED_TABLE_NAMES = new Set([
    "aggregate",
    "asId",
    "assertPatchAllowed",
    "cdcChangedTables",
    "count",
    "delete",
    "deleteAll",
    "deleteMany",
    "deleteRereadTables",
    "deleteWhere",
    "explain",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "get",
    "groupBy",
    "insert",
    "insertMany",
    "insertManyUnsafe",
    "inTransaction",
    "lookupById",
    "normalizeId",
    "patch",
    "patchIf",
    "patchMany",
    "patchWhere",
    "query",
    "rank",
    "rankBefore",
    "rankPage",
    "rankPageRows",
    "related",
    "relationEdges",
    "relationWrites",
    "replace",
    "restore",
    "softDeleteFields",
    "system",
    "wipeShard",
]);

/**
 * Table names are interpolated raw into generated type names (`Doc_${name}`)
 * and unquoted property keys — they must be JS identifiers. Must stay in
 * sync with `IDENTIFIER_RE` in `emit/shared.ts` (the emit-side E1 gate is
 * defense-in-depth behind this check).
 */
const TABLE_NAME_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Throw a pinpointed diagnostic when a discovered table key collides with a
 * `ctx.db` member, or is not a valid JS identifier. The `node` is the table's
 * name node (or the table builder expression) so the error points at the
 * offending declaration.
 */
const assertTableNameAllowed = (name: string, node: Node): void => {
    if (RESERVED_TABLE_NAMES.has(name)) {
        throw diagnosticAt(
            node,
            `table name "${name}" is reserved — the generated shard binds each table's facade onto the same object that carries \`ctx.db\`'s own members, so this table would overwrite \`ctx.db.${name}\` and every use of it would break. Rename the table.`,
        );
    }

    if (RESERVED_JS_WORDS.has(name)) {
        throw diagnosticAt(
            node,
            `table name "${name}" is a reserved JavaScript word — codegen interpolates table names into a bare \`const ${name} = sqliteTable(...)\` binding in the generated Drizzle module, which is a syntax error for a keyword. Rename the table.`,
        );
    }

    if (!TABLE_NAME_IDENTIFIER_RE.test(name)) {
        throw diagnosticAt(
            node,
            `table name ${JSON.stringify(name)} is not a valid JS identifier — table names are used in generated type names (Doc_<name>) and must match [A-Za-z_$][A-Za-z0-9_$]*. Rename the table.`,
        );
    }

    if (isInternalTableName(name)) {
        throw diagnosticAt(
            node,
            `table name ${JSON.stringify(name)} is reserved for framework tables — a leading \`__\` and the \`__agg_\`/\`__rank_\`/\`__geo_\`/\`__fts_\` infixes name Lunora's own bookkeeping and index companions, so the Studio and the admin API hide and refuse such a table. Rename the table.`,
        );
    }
};

const asOnDelete = (value: string | undefined): KeyedRelationIR["onDelete"] =>
    value && ON_DELETE_ACTIONS.has(value) ? (value as KeyedRelationIR["onDelete"]) : undefined;

/**
 * Unwrap a `.relations((r) => …)` arrow body to the object literal it returns,
 * looking through a parenthesized expression or a block with a `return`. Returns
 * `undefined` when the body isn't (or doesn't resolve to) an object literal.
 */
const relationsObjectBody = (argument: Node): ObjectLiteralExpression | undefined => {
    if (!Node.isArrowFunction(argument)) {
        return undefined;
    }

    let body: Node = argument.getBody();

    if (Node.isParenthesizedExpression(body)) {
        body = body.getExpression();
    } else if (Node.isBlock(body)) {
        const returnStatement = body.getStatements().find((statement) => Node.isReturnStatement(statement));

        body = returnStatement && Node.isReturnStatement(returnStatement) ? (returnStatement.getExpression() ?? body) : body;
    }

    return Node.isObjectLiteralExpression(body) ? body : undefined;
};

/**
 * Lift the `through: { table, from, to }` option of `r.many(target, { through })` into a {@link RelationIR}. The
 * three names feed the advisor's join-table lints, so like the target table they must be string literals.
 */
const throughRelation = (throughProperty: Node, name: string, table: string): RelationIR => {
    const literal = Node.isPropertyAssignment(throughProperty) ? throughProperty.getInitializer() : undefined;

    if (!literal || !Node.isObjectLiteralExpression(literal)) {
        throw diagnosticAt(throughProperty, "relation `through` must be an object literal `{ table, from, to }` — codegen resolves it statically.");
    }

    const [joinTable, from, to] = ["table", "from", "to"].map((key) => getStringProperty(literal, key));

    if (joinTable === undefined || from === undefined || to === undefined) {
        throw diagnosticAt(literal, "relation `through` needs string-literal `table`, `from` and `to` — codegen resolves them statically.");
    }

    if (from === to) {
        throw diagnosticAt(literal, `relation \`through\` has \`from\` and \`to\` both set to "${from}"; a link needs two different columns.`);
    }

    return { kind: "many", name, table, through: { from, table: joinTable, to } };
};

/** Build the {@link RelationIR} for `r.one`/`r.many` from its (possibly absent) options object: a `through` join table, or a foreign-key `field`. */
const relationFromOptions = (method: "many" | "one", name: string, table: string, options: Node | undefined): RelationIR => {
    const literal = options && Node.isObjectLiteralExpression(options) ? options : undefined;
    const throughProperty = method === "many" ? literal?.getProperty("through") : undefined;

    if (throughProperty) {
        return throughRelation(throughProperty, name, table);
    }

    return {
        field: (literal && getStringProperty(literal, "field")) ?? "_unknown_",
        kind: method,
        name,
        onDelete: method === "one" && literal ? asOnDelete(getStringProperty(literal, "onDelete")) : undefined,
        references: (literal && getStringProperty(literal, "references")) ?? "_id",
        table,
    };
};

/** Lift one `name: r.one(table, opts)` / `r.many(...)` property into a {@link RelationIR}, or `undefined`. */
const relationFromProperty = (property: Node): RelationIR | undefined => {
    if (!Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const callee = initializer.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();

    if (method !== "one" && method !== "many") {
        return undefined;
    }

    const [tableArgument, optionsExpression] = initializer.getArguments();

    // The relation's target table feeds straight into the generated
    // `OneRelation<"...">` / `ManyRelation<"...">` type (see `emit/data-model.ts`'s
    // relation-type emission) — codegen resolves it statically, so a
    // non-literal (or missing) target must fail loudly rather than degrade to
    // a placeholder that still compiles.
    if (!tableArgument || !Node.isStringLiteral(tableArgument)) {
        throw diagnosticAt(
            tableArgument ?? initializer,
            `relation target table must be a string literal — codegen resolves relation targets statically. Got ${tableArgument ? tableArgument.getText() : "no argument"}.`,
        );
    }

    const table = tableArgument.getLiteralText();

    return relationFromOptions(method, propertyKeyName(property), table, optionsExpression);
};

/**
 * Parse the `.relations((r) => ({ ... }))` argument. The arrow's body is an
 * object literal (usually parenthesized) whose every property is a
 * `r.one(table, opts)` / `r.many(table, opts)` call. `references` defaults to
 * `_id`; `onDelete` is captured only on `one`.
 */
const parseRelations = (argument: Node): RelationIR[] => {
    const body = relationsObjectBody(argument);

    if (!body) {
        return [];
    }

    const relations: RelationIR[] = [];

    for (const property of body.getProperties()) {
        const relation = relationFromProperty(property);

        if (relation) {
            relations.push(relation);
        }
    }

    return relations;
};

/**
 * Reject a dotted index field, naming the constraint and the workaround.
 *
 * Convex supports `.index("by_state", ["threadId", "state.kind", "order"])`, and
 * a discriminated-union state column with an indexed `kind` is a common idiom
 * there — so ports hit this. Lunora indexes only top-level columns: SQLite would
 * need a generated column, which the schema has no way to declare.
 *
 * Without this the failure surfaced from the drizzle renderer as `drizzle index
 * field is not a valid JS identifier: "state.kind"`, which names neither the
 * real constraint nor what to do instead.
 */
const assertTopLevelIndexField = (element: TsNode, field: string, indexName: string): void => {
    if (!field.includes(".")) {
        return;
    }

    const [head = "", ...rest] = field.split(".");
    const denormalised = `${head}${rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;

    throw diagnosticAt(
        element,
        `index "${indexName}" indexes the nested path ${JSON.stringify(field)} — Lunora indexes only top-level columns. ` +
            `Denormalise the value into its own column (e.g. \`${denormalised}\`), index that instead, and keep it in sync with a table \`.triggers()\` beforeInsert/beforeUpdate.`,
        // Same code `defineSchema` throws at runtime, so the CLI maps either path to exit 2.
        { code: "INDEX_FIELD_NESTED_PATH", name: "LunoraError", status: 500 },
    );
};

/**
 * Read `{ unique }` off an index's options object.
 *
 * `unique` must be a literal `true`/`false`. A computed value (`unique: !!x`,
 * `Boolean(...)`, a referenced const) can't be resolved statically here, so we
 * fail loudly rather than silently dropping a `uniqueIndex` from the emitted
 * metadata.
 */
const parseIndexUniqueOption = (optionsExpression: Node | undefined): boolean => {
    if (!optionsExpression || !Node.isObjectLiteralExpression(optionsExpression)) {
        return false;
    }

    const property = findObjectProperty(optionsExpression, "unique");

    if (!property || !Node.isPropertyAssignment(property)) {
        return false;
    }

    const initializer = property.getInitializer();

    if (initializer === undefined) {
        return false;
    }

    if (!Node.isTrueLiteral(initializer) && !Node.isFalseLiteral(initializer)) {
        throw diagnosticAt(initializer, `\`unique\` must be a literal \`true\` or \`false\`, got ${JSON.stringify(initializer.getText())}`);
    }

    return Node.isTrueLiteral(initializer);
};

/** Parse a `.index(name, [fields], { unique? })` call into an {@link IndexIR}. */
const parseIndexCall = (args: ReadonlyArray<Node>): IndexIR => {
    const [indexName, fieldsExpression, optionsExpression] = args;
    const unique = parseIndexUniqueOption(optionsExpression);
    const name = indexNameOf(indexName);
    const rawElements = fieldsExpression && Node.isArrayLiteralExpression(fieldsExpression) ? fieldsExpression.getElements() : [];

    // A computed element (`[FIELD]`, `...spread`) was silently dropped, so the
    // index emitted with fewer columns than it declares — and a partial index
    // reads as a working one right up until a query needs the missing column.
    for (const element of rawElements) {
        if (!Node.isStringLiteral(element)) {
            throw diagnosticAt(
                element,
                `index "${name}" lists a non-literal field (${JSON.stringify(element.getText())}); codegen reads index fields statically, so every entry must be a string literal.`,
            );
        }
    }

    const fieldElements = rawElements.filter((element): element is Expression & { getLiteralText: () => string } => Node.isStringLiteral(element));

    for (const element of fieldElements) {
        assertTopLevelIndexField(element, element.getLiteralText(), name);
    }

    return { fields: fieldElements.map((element) => element.getLiteralText()), name, unique };
};

/** Parse a `.searchIndex(name, { field, filterFields? })` call into a {@link SearchIndexIR}. */
const parseSearchIndexCall = (args: ReadonlyArray<Node>): SearchIndexIR => {
    const [indexName, optionsExpression] = args;
    let field = "_unknown_";
    let filterFields: string[] | undefined;
    let language: string | undefined;
    let staged: boolean | undefined;
    let strategy: string | undefined;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        field = getStringProperty(optionsExpression, "field") ?? field;
        filterFields = getStringArrayProperty(optionsExpression, "filterFields");
        language = getStringProperty(optionsExpression, "language");
        staged = getBooleanProperty(optionsExpression, "staged");
        strategy = getStringProperty(optionsExpression, "strategy");
    }

    return { field, filterFields, language, name: indexNameOf(indexName), staged, strategy };
};

/** Parse a `.geoIndex(name, { field, precision? })` call into a {@link GeoIndexIR}. */
const parseGeoIndexCall = (args: ReadonlyArray<Node>): GeoIndexIR => {
    const [indexName, optionsExpression] = args;
    let field = "_unknown_";
    let precision: number | undefined;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        field = getStringProperty(optionsExpression, "field") ?? field;
        precision = getNumberProperty(optionsExpression, "precision");
    }

    return { field, name: indexNameOf(indexName), precision };
};

/** Parse a `.ttl(field, { after? })` call into a {@link TtlIR}. */
const parseTtlCall = (args: ReadonlyArray<Node>): TtlIR => {
    const [fieldArgument, optionsExpression] = args;
    const field = fieldArgument && Node.isStringLiteral(fieldArgument) ? fieldArgument.getLiteralText() : "_unknown_";
    let after: number | undefined;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        after = getNumberProperty(optionsExpression, "after");
    }

    return { after, field };
};

/**
 * Parse one `{ field, direction? }` entry of a rank index's `sortBy` array into a
 * {@link RankSortKeyIR}. `direction` defaults to `"asc"`, mirroring the runtime
 * `.rankIndex(...)` builder.
 */
const rankSortKeyFromElement = (element: Node): RankSortKeyIR | undefined => {
    if (!Node.isObjectLiteralExpression(element)) {
        return undefined;
    }

    const field = getStringProperty(element, "field");

    if (field === undefined) {
        return undefined;
    }

    const direction = getStringProperty(element, "direction");

    return { direction: direction === "desc" ? "desc" : "asc", field };
};

/** Parse a `.rankIndex(name, { sortBy, partitionBy?, where? })` call into a {@link RankIndexIR}. */
const parseRankIndexCall = (args: ReadonlyArray<Node>): RankIndexIR => {
    const [indexName, optionsExpression] = args;
    let sortBy: RankSortKeyIR[] = [];
    let partitionBy: string[] | undefined;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        const sortByProperty = findObjectProperty(optionsExpression, "sortBy");

        if (sortByProperty && Node.isPropertyAssignment(sortByProperty)) {
            const initializer = sortByProperty.getInitializer();

            if (initializer && Node.isArrayLiteralExpression(initializer)) {
                sortBy = initializer
                    .getElements()
                    .map((element) => rankSortKeyFromElement(element))
                    .filter((key): key is RankSortKeyIR => key !== undefined);
            }
        }

        partitionBy = getStringArrayProperty(optionsExpression, "partitionBy");
    }

    return { name: indexNameOf(indexName), partitionBy, sortBy };
};

/** Parse a `.vectorize(field, { ... })` call into a {@link VectorIndexIR}, or `undefined` when options are absent. */
const parseVectorizeCall = (args: ReadonlyArray<Node>, table: string): VectorIndexIR | undefined => {
    const [fieldArgument, optionsExpression] = args;
    const field = fieldArgument && Node.isStringLiteral(fieldArgument) ? fieldArgument.getLiteralText() : "_unknown_";

    if (!optionsExpression || !Node.isObjectLiteralExpression(optionsExpression)) {
        return undefined;
    }

    return {
        dimensions: getNumberProperty(optionsExpression, "dimensions"),
        field,
        metadata: getStringArrayProperty(optionsExpression, "metadata"),
        metric: asMetric(getStringProperty(optionsExpression, "metric")),
        name: getStringProperty(optionsExpression, "index") ?? "_unnamed_",
        table,
    };
};

/** Read the optional `{ backend }` argument of a `.global({ backend })` call; defaults to `"d1"`. */
const parseGlobalBackend = (args: ReadonlyArray<Node>): TableIR["globalBackend"] => {
    const optionsExpression = args[0];

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        const backend = getStringProperty(optionsExpression, "backend");

        if (backend === "hyperdrive") {
            return "hyperdrive";
        }
    }

    return "d1";
};

/** Accumulator the builder-chain walk mutates as it unwinds a `defineTable(...)` chain. */
interface TableBuilderAccumulator {
    aggregateIndexed: boolean;
    commitOrdered: boolean;
    externallyManaged: boolean;
    externalSource?: ExternalSourceIR;
    geoIndexes: GeoIndexIR[];
    globalBackend?: TableIR["globalBackend"];
    indexes: IndexIR[];
    isPublic: boolean;
    memory: boolean;
    rankIndexes: RankIndexIR[];
    relations: RelationIR[];
    searchIndexes: SearchIndexIR[];
    shardMode: TableIR["shardMode"];
    softDelete?: { field: string };
    /** One entry per `.timestamps()` call; more than one is refused. */
    timestampsFields: string[];
    ttl?: TtlIR;
    vectorIndexes: VectorIndexIR[];
}

/**
 * Read the column name off a `.softDelete({ field })` / `.timestamps({ field })` options arg; `fallback` when absent.
 * Codegen cannot evaluate an expression, and silently falling back would generate types for a column the runtime
 * never creates, so a `field` that is not a string literal is refused.
 */
const fieldOptionOf = (optionsArgument: Node | undefined, fallback: string): string => {
    if (optionsArgument === undefined) {
        return fallback;
    }

    if (!Node.isObjectLiteralExpression(optionsArgument)) {
        throw diagnosticAt(
            optionsArgument,
            "the options must be an object literal — codegen reads the column name from the source and cannot evaluate a variable or an expression here.",
        );
    }

    const fieldProperty = findObjectProperty(optionsArgument, "field");

    if (fieldProperty === undefined) {
        return fallback;
    }

    const initializer = Node.isPropertyAssignment(fieldProperty) ? fieldProperty.getInitializer() : undefined;

    if (initializer && Node.isStringLiteral(initializer)) {
        return initializer.getLiteralText();
    }

    throw diagnosticAt(
        fieldProperty,
        "`field` must be a string literal — codegen reads the column name from the source and cannot evaluate a constant or an expression here.",
    );
};

/**
 * Parse a `.source({ ... })` call into {@link ExternalSourceIR} — the
 * statically-knowable bits only. `map`/`tenantBy` are functions, so only their
 * presence is recorded (`hasTenantBy`/`hasReconcile`/`hasSoftDelete`);
 * `binding`/`query`/`idColumn`/`mode`/`columns` are read when they are string (or
 * string-array) literals.
 *
 * When the argument is **not** a static object literal (e.g. `.source(buildConfig())`),
 * the fields can't be read — but the source still exists, so we return an
 * `unanalyzable` sentinel rather than `undefined`. Returning `undefined` here would
 * make a dynamic source indistinguishable from no `.source()` at all, silently
 * dropping it from `hasSourcedTables` (no poll override emitted) and from the
 * `external_source_unscoped` / `external_source_on_global` security lints.
 */
const parseSourceCall = (args: ReadonlyArray<Node>): ExternalSourceIR => {
    const first = args[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return { binding: "", hasTenantBy: false, unanalyzable: true };
    }

    return {
        binding: getStringProperty(first, "binding") ?? "",
        columns: stringArrayPropertyOf(first, "columns"),
        hasReconcile: findObjectProperty(first, "reconcileEveryMs") !== undefined,
        hasSoftDelete: findObjectProperty(first, "softDeleteColumn") !== undefined,
        hasTenantBy: findObjectProperty(first, "tenantBy") !== undefined,
        idColumn: getStringProperty(first, "idColumn"),
        mode: getStringProperty(first, "mode"),
        query: getStringProperty(first, "query"),
    };
};

/** Apply one chained method call (`.index`, `.shardBy`, …) to the accumulator. */
const applyTableMethod = (accumulator: TableBuilderAccumulator, method: string, args: ReadonlyArray<Node>, name: string): void => {
    switch (method) {
        case "aggregateIndex": {
            // The index's options are read by the runtime; codegen needs only that one exists.
            accumulator.aggregateIndexed = true;

            break;
        }

        case "commitOrdered": {
            // `.commitOrdered()` takes no arguments — its presence is the whole
            // declaration. The `_commitSeq` field it adds is NOT injected into
            // `shape`: like `_id`/`_creationTime` it is runtime-minted and
            // rendered directly onto `Doc_*`, so a user column of that name would
            // be a collision rather than a duplicate.
            accumulator.commitOrdered = true;

            break;
        }

        case "externallyManaged": {
            accumulator.externallyManaged = true;

            break;
        }

        case "geoIndex": {
            accumulator.geoIndexes.push(parseGeoIndexCall(args));

            break;
        }

        case "global": {
            accumulator.shardMode = "global";
            accumulator.globalBackend = parseGlobalBackend(args);

            break;
        }

        case "index": {
            // The chain is unwound outermost-first, so each index is prepended to land in declaration order: the
            // planner lets an earlier index claim a shared column, so the order is part of the schema.
            accumulator.indexes.unshift(parseIndexCall(args));

            break;
        }

        case "memory": {
            // `.memory()` takes no arguments — its presence is the declaration.
            accumulator.memory = true;

            break;
        }

        case "public": {
            accumulator.isPublic = true;

            break;
        }

        case "rankIndex": {
            accumulator.rankIndexes.push(parseRankIndexCall(args));

            break;
        }

        case "relations": {
            const builder = args[0];

            if (builder) {
                accumulator.relations.push(...parseRelations(builder));
            }

            break;
        }

        case "searchIndex": {
            accumulator.searchIndexes.push(parseSearchIndexCall(args));

            break;
        }

        case "shardBy": {
            const field = args[0];

            accumulator.shardMode = { field: field && Node.isStringLiteral(field) ? field.getLiteralText() : "_unknown_", kind: "shardBy" };

            break;
        }

        case "softDelete": {
            // `.softDelete()` or `.softDelete({ field: "removedAt" })` — read the
            // optional marker-column name off the options object (default `deletedAt`).
            accumulator.softDelete = { field: fieldOptionOf(args[0], "deletedAt") };

            break;
        }

        case "source": {
            // `.source({ ... })` — capture the statically-knowable config and, like
            // the runtime builder, imply `.externallyManaged()` (rows come from the
            // ingest loop, not a discoverable `ctx.db.insert`).
            accumulator.externalSource = parseSourceCall(args);
            accumulator.externallyManaged = true;

            break;
        }

        case "timestamps": {
            // `.timestamps()` or `.timestamps({ field: "modifiedAt" })`.
            accumulator.timestampsFields.push(fieldOptionOf(args[0], "updatedAt"));

            break;
        }

        case "ttl": {
            accumulator.ttl = parseTtlCall(args);

            break;
        }

        case "vectorize": {
            const vectorIndex = parseVectorizeCall(args, name);

            if (vectorIndex) {
                accumulator.vectorIndexes.push(vectorIndex);
            }

            break;
        }

        default: {
            break;
        }
    }
};

/**
 * Every companion table created alongside a search index's FTS5 table `X`.
 *
 * The single-underscore five are SQLite's own shadow tables. Their names are
 * reserved, so `CREATE VIRTUAL TABLE` on a colliding name is rejected outright.
 *
 * `__vocab` is Lunora's — `runShardMigrations` creates an `fts5vocab` companion
 * per index. It matters MORE than the reserved five, not less: it is created
 * with `IF NOT EXISTS`, so a collision does not error. The second index simply
 * binds to the first's vocab table and returns wrong results, silently.
 * @see {@link https://www.sqlite.org/fts5.html}
 */
const FTS5_SHADOW_SUFFIXES = ["__vocab", "_config", "_content", "_data", "_docsize", "_idx"] as const;

/**
 * Reject two search indexes on one table whose generated FTS5 table names
 * collide through a shadow-table suffix.
 *
 * `ftsTableName` renders `<table>__fts_<indexName>`, so `search_prompts` and
 * `search_prompts_content` on the same table produce `prompts__fts_search_prompts`
 * and `prompts__fts_search_prompts_content` — and the FIRST index already
 * reserved the second name as its own `_content` shadow. Creating the second
 * fails with `object name reserved for internal use: SQLITE_ERROR`.
 *
 * This is worth a static check rather than a runtime error because of where the
 * runtime error lands: `ensureMigrated` throws on the shard's first admin RPC,
 * so EVERY `.shardBy()` table becomes unreadable and unwritable, the HTTP
 * response is still a 200, and the cause appears only in the worker log. The
 * index names are a legal pair; nothing else in the toolchain objects.
 */
const assertNoFtsShadowCollision = (expression: Expression, table: string, searchIndexes: ReadonlyArray<SearchIndexIR>): void => {
    const declared = new Set(searchIndexes.map((index) => index.name));

    for (const index of searchIndexes) {
        for (const suffix of FTS5_SHADOW_SUFFIXES) {
            const shadowed = `${index.name}${suffix}`;

            if (!declared.has(shadowed)) {
                continue;
            }

            // The consequence differs by suffix, so the message must too.
            // SQLite's five shadow names are RESERVED: the second `CREATE
            // VIRTUAL TABLE` is rejected, which aborts the shard migration.
            // `__vocab` is Lunora's own and is created `IF NOT EXISTS`, so
            // nothing is rejected — the second index binds to the first's vocab
            // table and returns wrong results with no error at all.
            const consequence =
                suffix === "__vocab"
                    ? `the \`fts5vocab\` companion for "${shadowed}" is created \`IF NOT EXISTS\`, so it silently resolves to "${index.name}"'s — the second index then reads the wrong vocabulary and returns wrong results, with no error`
                    : `creating "${shadowed}" is rejected (\`object name reserved for internal use: SQLITE_ERROR\`), which aborts the shard migration and leaves every sharded table unreadable`;

            throw diagnosticAt(
                expression,
                `table "${table}" declares search indexes "${index.name}" and "${shadowed}", whose generated FTS5 tables collide: ` +
                    `"${index.name}" already owns "${table}__fts_${shadowed}" as its "${suffix}" companion, so ${consequence}. ` +
                    `Rename one of them so neither ends with another's name plus ${FTS5_SHADOW_SUFFIXES.join(", ")}.`,
            );
        }
    }
};

/**
 * Reject `.ttl()` on a `.global()` table — mirrors `defineSchema`'s runtime
 * refusal, so the build fails at the table rather than the emitter quietly
 * generating no sweep for rows no shard alarm can reach.
 */
const assertNoGlobalTtl = (expression: Expression, table: string, accumulator: TableBuilderAccumulator): void => {
    if (accumulator.ttl !== undefined && accumulator.shardMode === "global") {
        throw diagnosticAt(expression, globalTtlMessage(table));
    }
};

/**
 * `.softDelete()` and `.timestamps()` inject a column into the shape, mirroring the runtime builder, so `Doc_*` /
 * `Insert_*` carry it. A column the author declared wins, and the runtime builder's refusals are repeated here so
 * a schema that throws at load fails at codegen too: a second `.timestamps()`, the soft-delete field reused, or a
 * declared column that would not restamp on update.
 */
const withInjectedColumns = (expression: Expression, shape: Record<string, ValidatorIR>, accumulator: TableBuilderAccumulator): Record<string, ValidatorIR> => {
    const { softDelete, timestampsFields } = accumulator;
    const injected: Record<string, ValidatorIR> = {};

    if (softDelete && !(softDelete.field in shape)) {
        injected[softDelete.field] = { inner: { column: { notNull: false }, kind: "number" }, kind: "optional" };
    }

    const [timestamps] = timestampsFields;

    if (timestamps === undefined) {
        return { ...shape, ...injected };
    }

    if (timestampsFields.length > 1) {
        throw diagnosticAt(expression, "`.timestamps()` was called more than once; one table tracks one last-change column.");
    }

    if (timestamps === softDelete?.field) {
        throw diagnosticAt(expression, `\`.softDelete()\` and \`.timestamps()\` both use "${timestamps}"; give one of them another field.`);
    }

    const declared = shape[timestamps];

    if (declared === undefined) {
        injected[timestamps] = { column: { hasDefault: true, hasOnUpdate: true, notNull: true }, kind: "timestamp" };
    } else if (declared.kind !== "timestamp" || declared.column?.hasOnUpdate !== true || declared.column.hasDefault !== true) {
        throw diagnosticAt(
            expression,
            `\`.timestamps()\` would add "${timestamps}", but the table already declares it as something other than \`v.timestamp().defaultNow().$onUpdateFn(() => Date.now())\`; remove the column or declare it that way.`,
        );
    }

    return { ...shape, ...injected };
};

const parseTableBuilder = (expression: Expression, name: string): TableIR => {
    const accumulator: TableBuilderAccumulator = {
        aggregateIndexed: false,
        commitOrdered: false,
        externallyManaged: false,
        geoIndexes: [],
        indexes: [],
        isPublic: false,
        memory: false,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shardMode: "root",
        timestampsFields: [],
        vectorIndexes: [],
    };
    let shape: Record<string, ValidatorIR> = {};
    let current: Expression = expression;

    // Unwind the chain: e.g. defineTable({...}).index(...).shardBy("x")
    while (Node.isCallExpression(current)) {
        const callee = current.getExpression();
        const args = current.getArguments();

        if (Node.isPropertyAccessExpression(callee)) {
            applyTableMethod(accumulator, callee.getName(), args, name);
            current = callee.getExpression();
        } else if (Node.isIdentifier(callee) && callee.getText() === "defineTable") {
            // Reached the base defineTable({...}) call.
            const first = args[0];

            if (first && Node.isObjectLiteralExpression(first)) {
                shape = parseObjectShape(first);
            } else if (first) {
                // `defineTable(fieldsIdentifier)` is what anyone writes to share a
                // field map between the schema and an `.input()`. Codegen reads the
                // shape syntactically, so a non-literal argument silently yielded a
                // table with NO columns — `Doc_<table>` came out with `_id` and
                // `_creationTime` and nothing else, with no error anywhere.
                // A column-less table is never intended.
                throw diagnosticAt(
                    first,
                    `table "${name}" calls defineTable(${JSON.stringify(first.getText())}), but codegen reads the field map syntactically and can only read an object literal. ` +
                        `Inline the fields into the defineTable(...) call. To reuse them in an \`.input()\`, derive from the generated \`Doc_${name}\` / \`Insert_${name}\` type instead of sharing the runtime value.`,
                );
            }

            break;
        } else {
            break;
        }
    }

    shape = withInjectedColumns(expression, shape, accumulator);

    assertNoFtsShadowCollision(expression, name, accumulator.searchIndexes);

    assertNoGlobalTtl(expression, name, accumulator);

    return {
        ...(accumulator.aggregateIndexed ? { aggregateIndexed: true as const } : {}),
        commitOrdered: accumulator.commitOrdered,
        externallyManaged: accumulator.externallyManaged,
        externalSource: accumulator.externalSource,
        geoIndexes: accumulator.geoIndexes,
        globalBackend: accumulator.shardMode === "global" ? (accumulator.globalBackend ?? "d1") : undefined,
        indexes: accumulator.indexes,
        isPublic: accumulator.isPublic,
        memory: accumulator.memory,
        name,
        rankIndexes: accumulator.rankIndexes,
        relations: accumulator.relations,
        searchIndexes: accumulator.searchIndexes,
        shape,
        shardMode: accumulator.shardMode,
        softDelete: accumulator.softDelete,
        ttl: accumulator.ttl,
        vectorIndexes: accumulator.vectorIndexes,
    };
};

/**
 * Parse the base `defineSchema({ table: defineTable(...) })` object literal into
 * {@link TableIR}s.
 *
 * A spread is followed when it names a readable table map (a local
 * `const sharedTables = { ... }`), so those tables reach the data model
 * instead of vanishing from it. One built by a CALL (`...authTables(options)`,
 * the documented `@lunora/auth` wiring) has no literal to read and is skipped,
 * exactly as every spread was before. Not an error: that path has no inline form
 * to fall back to, so refusing it would leave it unable to generate at all.
 *
 * `visited` guards a self- or mutually-referential spread; the duplicate-name
 * check spans the spread and the inline keys together, which is exactly the
 * collision `authTables`' own docs warn silently loses a table to spread order.
 */
const parseBaseTables = (object: ObjectLiteralExpression, tables: TableIR[] = [], seenNames = new Set<string>(), visited = new Set<Node>()): TableIR[] => {
    visited.add(object);

    for (const property of object.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            const spread = resolveObjectLiteral(property.getExpression());

            if (spread !== undefined && !visited.has(spread)) {
                parseBaseTables(spread, tables, seenNames, visited);
            }

            continue;
        }

        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (initializer) {
            const name = propertyKeyName(property);

            assertTableNameAllowed(name, property.getNameNode());

            if (seenNames.has(name)) {
                throw diagnosticAt(
                    property.getNameNode(),
                    `defineSchema({...}): table "${name}" is declared more than once — the earlier declaration would be silently discarded. Remove the duplicate.`,
                );
            }

            seenNames.add(name);
            tables.push(parseTableBuilder(initializer, name));
        }
    }

    return tables;
};

export { assertTableNameAllowed, parseBaseTables, parseTableBuilder, RESERVED_TABLE_NAMES, TABLE_NAME_IDENTIFIER_RE };
