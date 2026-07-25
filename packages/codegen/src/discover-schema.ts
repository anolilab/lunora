import { LunoraError } from "@lunora/errors";
import type { CallExpression, Expression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type {
    ExternalSourceIR,
    GeoIndexIR,
    IndexIR,
    RankIndexIR,
    RankSortKeyIR,
    RelationIR,
    SchemaIR,
    SearchIndexIR,
    TableIR,
    TtlIR,
    ValidatorIR,
    VectorIndexIR,
} from "./ir";
import { parseObjectShape } from "./parse-validator";
import { resolvePackageExtension } from "./resolve-package-extension";

const VECTOR_METRICS = new Set(["cosine", "dot-product", "euclidean"]);
const ON_DELETE_ACTIONS = new Set(["cascade", "restrict", "set null"]);

/**
 * Table names that collide with members of `ctx.db` (the typed reader/writer the
 * generated `_generated/server.ts` widens with the per-table facade). A table so
 * named would shadow the corresponding `ctx.db.&lt;member>` and silently corrupt
 * the emitted type, so codegen rejects it up front with a clear diagnostic.
 */
const RESERVED_TABLE_NAMES = new Set(["delete", "get", "insert", "normalizeId", "patch", "query", "replace", "system"]);

/**
 * Throw a pinpointed diagnostic when a discovered table key collides with a
 * `ctx.db` member. The `node` is the table's name node (or the table builder
 * expression) so the error points at the offending declaration.
 */
const assertTableNameAllowed = (name: string, node: Node): void => {
    if (RESERVED_TABLE_NAMES.has(name)) {
        throw diagnosticAt(
            node,
            `table name "${name}" is reserved — it collides with a \`ctx.db\` member (one of ${[...RESERVED_TABLE_NAMES].map((reserved) => `"${reserved}"`).join(", ")}). Rename the table.`,
        );
    }
};

/** Read a string-literal property from an object literal, or `undefined`. */
const getStringProperty = (object: ObjectLiteralExpression, key: string): string | undefined => {
    const property = object.getProperty(key);

    if (property && Node.isPropertyAssignment(property)) {
        const initializer = property.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            return initializer.getLiteralText();
        }
    }

    return undefined;
};

/** Read a numeric-literal property from an object literal, or `undefined`. */
const getNumberProperty = (object: ObjectLiteralExpression, key: string): number | undefined => {
    const property = object.getProperty(key);

    if (property && Node.isPropertyAssignment(property)) {
        const initializer = property.getInitializer();

        if (initializer && Node.isNumericLiteral(initializer)) {
            return Number(initializer.getLiteralText());
        }
    }

    return undefined;
};

/** Read an array-of-string-literals property, or `undefined`. */
const getStringArrayProperty = (object: ObjectLiteralExpression, key: string): string[] | undefined => {
    const property = object.getProperty(key);

    if (property && Node.isPropertyAssignment(property)) {
        const initializer = property.getInitializer();

        if (initializer && Node.isArrayLiteralExpression(initializer)) {
            return initializer
                .getElements()
                .filter((element): element is Expression & { getLiteralText: () => string } => Node.isStringLiteral(element))
                .map((element) => element.getLiteralText());
        }
    }

    return undefined;
};

const asMetric = (value: string | undefined): VectorIndexIR["metric"] => (value && VECTOR_METRICS.has(value) ? (value as VectorIndexIR["metric"]) : undefined);

const asOnDelete = (value: string | undefined): RelationIR["onDelete"] =>
    value && ON_DELETE_ACTIONS.has(value) ? (value as RelationIR["onDelete"]) : undefined;

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
    const table = tableArgument && Node.isStringLiteral(tableArgument) ? tableArgument.getLiteralText() : "_unknown_";

    let field = "_unknown_";
    let references = "_id";
    let onDelete: RelationIR["onDelete"];

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        field = getStringProperty(optionsExpression, "field") ?? field;
        references = getStringProperty(optionsExpression, "references") ?? references;
        onDelete = method === "one" ? asOnDelete(getStringProperty(optionsExpression, "onDelete")) : undefined;
    }

    return { field, kind: method, name: property.getName(), onDelete, references, table };
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

/** Read the literal name of an index/search/vector builder's first string argument, or `"_unnamed_"`. */
const indexNameOf = (nameArgument: Node | undefined): string =>
    nameArgument && Node.isStringLiteral(nameArgument) ? nameArgument.getLiteralText() : "_unnamed_";

/** Parse a `.index(name, [fields], { unique? })` call into an {@link IndexIR}. */
const parseIndexCall = (args: ReadonlyArray<Node>): IndexIR => {
    const [indexName, fieldsExpression, optionsExpression] = args;
    let unique = false;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        const property = optionsExpression.getProperty("unique");

        if (property && Node.isPropertyAssignment(property)) {
            const initializer = property.getInitializer();

            // `unique` must be a literal `true`/`false`. A computed value
            // (`unique: !!x`, `Boolean(...)`, a referenced const) can't be
            // resolved statically here, so we fail loudly rather than silently
            // dropping a `uniqueIndex` from the emitted metadata.
            if (initializer && !Node.isTrueLiteral(initializer) && !Node.isFalseLiteral(initializer)) {
                throw diagnosticAt(initializer, `\`unique\` must be a literal \`true\` or \`false\`, got ${JSON.stringify(initializer.getText())}`);
            }

            unique = initializer ? Node.isTrueLiteral(initializer) : false;
        }
    }

    const fields =
        fieldsExpression && Node.isArrayLiteralExpression(fieldsExpression)
            ? fieldsExpression
                  .getElements()
                  .filter((element): element is Expression & { getLiteralText: () => string } => Node.isStringLiteral(element))
                  .map((element) => element.getLiteralText())
            : [];

    return { fields, name: indexNameOf(indexName), unique };
};

/** Parse a `.searchIndex(name, { field, filterFields? })` call into a {@link SearchIndexIR}. */
const parseSearchIndexCall = (args: ReadonlyArray<Node>): SearchIndexIR => {
    const [indexName, optionsExpression] = args;
    let field = "_unknown_";
    let filterFields: string[] | undefined;

    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
        field = getStringProperty(optionsExpression, "field") ?? field;
        filterFields = getStringArrayProperty(optionsExpression, "filterFields");
    }

    return { field, filterFields, name: indexNameOf(indexName) };
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
        const sortByProperty = optionsExpression.getProperty("sortBy");

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
    externallyManaged: boolean;
    externalSource?: ExternalSourceIR;
    geoIndexes: GeoIndexIR[];
    globalBackend?: TableIR["globalBackend"];
    indexes: IndexIR[];
    isPublic: boolean;
    rankIndexes: RankIndexIR[];
    relations: RelationIR[];
    searchIndexes: SearchIndexIR[];
    shardMode: TableIR["shardMode"];
    softDelete?: { field: string };
    ttl?: TtlIR;
    vectorIndexes: VectorIndexIR[];
}

/** Read the marker-column name off a `.softDelete({ field })` options arg; defaults to `deletedAt`. */
const softDeleteFieldOf = (optionsArgument: Node | undefined): string => {
    if (optionsArgument && Node.isObjectLiteralExpression(optionsArgument)) {
        const fieldProperty = optionsArgument.getProperty("field");

        if (fieldProperty && Node.isPropertyAssignment(fieldProperty)) {
            const initializer = fieldProperty.getInitializer();

            if (initializer && Node.isStringLiteral(initializer)) {
                return initializer.getLiteralText();
            }
        }
    }

    return "deletedAt";
};

/** Read a string-literal property off an object literal, or `undefined` when absent/non-literal. */
const stringPropertyOf = (object: ObjectLiteralExpression, property: string): string | undefined => {
    const node = object.getProperty(property);

    if (node && Node.isPropertyAssignment(node)) {
        const initializer = node.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            return initializer.getLiteralText();
        }
    }

    return undefined;
};

/** Read a string-array-literal property off an object literal, or `undefined`. */
const stringArrayPropertyOf = (object: ObjectLiteralExpression, property: string): string[] | undefined => {
    const node = object.getProperty(property);

    if (node && Node.isPropertyAssignment(node)) {
        const initializer = node.getInitializer();

        if (initializer && Node.isArrayLiteralExpression(initializer)) {
            const items = initializer
                .getElements()
                .filter((element) => Node.isStringLiteral(element))
                .map((element) => element.getLiteralText());

            return items.length > 0 ? items : undefined;
        }
    }

    return undefined;
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
        binding: stringPropertyOf(first, "binding") ?? "",
        columns: stringArrayPropertyOf(first, "columns"),
        hasReconcile: first.getProperty("reconcileEveryMs") !== undefined,
        hasSoftDelete: first.getProperty("softDeleteColumn") !== undefined,
        hasTenantBy: first.getProperty("tenantBy") !== undefined,
        idColumn: stringPropertyOf(first, "idColumn"),
        mode: stringPropertyOf(first, "mode"),
        query: stringPropertyOf(first, "query"),
    };
};

/** Apply one chained method call (`.index`, `.shardBy`, …) to the accumulator. */
const applyTableMethod = (accumulator: TableBuilderAccumulator, method: string, args: ReadonlyArray<Node>, name: string): void => {
    switch (method) {
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
            accumulator.indexes.push(parseIndexCall(args));

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
            accumulator.softDelete = { field: softDeleteFieldOf(args[0]) };

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

const parseTableBuilder = (expression: Expression, name: string): TableIR => {
    const accumulator: TableBuilderAccumulator = {
        externallyManaged: false,
        geoIndexes: [],
        indexes: [],
        isPublic: false,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shardMode: "root",
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
            }

            break;
        } else {
            break;
        }
    }

    // `.softDelete()` injects the marker column into the shape (mirrors the
    // runtime builder) so `Doc_*`/`Insert_*` carry it — optional + nullable
    // (`number | null | undefined`), absent on a live row. The user's own
    // declaration of the column wins (matches the runtime `if (!(field in shape))`).
    if (accumulator.softDelete && !(accumulator.softDelete.field in shape)) {
        shape = { ...shape, [accumulator.softDelete.field]: { inner: { kind: "number" }, kind: "optional" } };
    }

    return {
        externallyManaged: accumulator.externallyManaged,
        externalSource: accumulator.externalSource,
        geoIndexes: accumulator.geoIndexes,
        globalBackend: accumulator.shardMode === "global" ? (accumulator.globalBackend ?? "d1") : undefined,
        indexes: accumulator.indexes,
        isPublic: accumulator.isPublic,
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

/** Read the `source.table` literal off a `defineVectorIndex({ source: { table } })` options object. */
const sourceTableOf = (optionsExpression: ObjectLiteralExpression): string => {
    const sourceProperty = optionsExpression.getProperty("source");

    if (sourceProperty && Node.isPropertyAssignment(sourceProperty)) {
        const sourceInitializer = sourceProperty.getInitializer();

        if (sourceInitializer && Node.isObjectLiteralExpression(sourceInitializer)) {
            return getStringProperty(sourceInitializer, "table") ?? "_unknown_";
        }
    }

    return "_unknown_";
};

/** Lift one `name: defineVectorIndex({...})` property into a {@link VectorIndexIR}, or `undefined`. */
const standaloneVectorIndexFromProperty = (property: Node): VectorIndexIR | undefined => {
    if (!Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const callee = initializer.getExpression();

    if (!Node.isIdentifier(callee) || callee.getText() !== "defineVectorIndex") {
        return undefined;
    }

    const optionsExpression = initializer.getArguments()[0];

    if (!optionsExpression || !Node.isObjectLiteralExpression(optionsExpression)) {
        return undefined;
    }

    const nameNode = property.getNameNode();
    const indexName = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();

    return {
        dimensions: getNumberProperty(optionsExpression, "dimensions"),
        metric: asMetric(getStringProperty(optionsExpression, "metric")),
        name: indexName,
        table: sourceTableOf(optionsExpression),
    };
};

/**
 * Parse the optional second argument to `defineSchema(...)` — a map of index
 * name -> `defineVectorIndex({...})` call (DSL Shape B). The embedded text
 * source is a `select` function, so `field`/`metadata` stay undefined here.
 */
const parseStandaloneVectorIndexes = (object: ObjectLiteralExpression): VectorIndexIR[] => {
    const result: VectorIndexIR[] = [];

    for (const property of object.getProperties()) {
        const index = standaloneVectorIndexFromProperty(property);

        if (index) {
            result.push(index);
        }
    }

    return result;
};

/**
 * Apply the extension `key` prefix to a bare table name. Mirrors the runtime
 * `prefixTableName` in `@lunora/server`'s `plugin.ts` so generated names match.
 */
const prefixTableName = (key: string, bareName: string): string => `${key}_${bareName}`;

/**
 * Rewrite a single intra-extension table reference to its prefixed name. A
 * reference is "intra-extension" only when its target is one of the extension's
 * own bare table names; references to base/app tables are returned untouched.
 * Mirrors the runtime `rewriteReference`.
 */
const rewriteReference = (target: string, key: string, bareNames: ReadonlySet<string>): string =>
    bareNames.has(target) ? prefixTableName(key, target) : target;

/**
 * Apply the runtime namespacing transform to one parsed extension table:
 * prefix the table's own name, rewrite relation targets, and rewrite inline
 * vector-index `table` references. The inline-vectorize parser stamps the
 * owning (bare) table name onto each `vectorIndexes[].table`, which is always
 * an intra-extension reference, so it always resolves to the prefixed owner.
 *
 * Rank indexes (`table.rankIndexes`) are captured in the IR but carry no
 * cross-table reference — a rank index's owner is always the table it is
 * declared on, which is `ownPrefixed`. So the `...table` spread carries them
 * onto the prefixed table verbatim; there is nothing extra to rewrite, and the
 * emitted `RankIndexNamesByTable` keys them under the prefixed name for free.
 *
 * Aggregate indexes are not represented in the codegen IR (the table builder
 * walk doesn't capture them) and have no name consumer in the generated query
 * API (they resolve by `{op, field?, where?}`), so there is nothing to rewrite
 * here — unlike the runtime, which additionally rewrites their `on` fields.
 */
const namespaceExtensionTable = (table: TableIR, key: string, bareNames: ReadonlySet<string>): TableIR => {
    const ownPrefixed = prefixTableName(key, table.name);

    return {
        ...table,
        // Provenance for the generated `AppTableName` union — this table came from
        // an add-on, not from the app's own `defineSchema`.
        extensionKey: key,
        name: ownPrefixed,
        relations: table.relations.map((relation) => {
            return { ...relation, table: rewriteReference(relation.table, key, bareNames) };
        }),
        // Inline `.vectorize()` stamps `table` with the bare owner name, so it
        // is always one of `bareNames` and resolves to `ownPrefixed`.
        vectorIndexes: table.vectorIndexes.map((index) => {
            return { ...index, table: rewriteReference(index.table, key, bareNames) };
        }),
    };
};

/** The initializer expression a resolved declaration carries, or `undefined` for a declaration we don't follow. */
const declarationInitializer = (declaration: TsNode): Expression | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        return declaration.getInitializer();
    }

    if (Node.isShorthandPropertyAssignment(declaration)) {
        return declaration.getNameNode();
    }

    return undefined;
};

/** Read the named property's initializer off an object literal, or `undefined` when absent / not a plain property assignment. */
const objectPropertyInitializer = (objectLiteral: ObjectLiteralExpression, name: string): Expression | undefined => {
    const property = objectLiteral.getProperty(name);

    if (property && Node.isPropertyAssignment(property)) {
        return property.getInitializer();
    }

    return undefined;
};

/** True when `argument` is a direct inline `defineSchemaExtension("k", {...})` call. */
const isInlineExtensionCall = (argument: TsNode): argument is CallExpression => {
    if (!Node.isCallExpression(argument)) {
        return false;
    }

    const callee = argument.getExpression();

    return Node.isIdentifier(callee) && callee.getText() === "defineSchemaExtension";
};

/**
 * The identifier to resolve for an identifier / property-access `.extend(...)`
 * argument, or `undefined`. For `.extend(plugin.extension)` we resolve the
 * RECEIVER (`plugin`), NOT the `.extension` name: a `definePlugin(...)` /
 * `defineSchemaExtension(...)` value has a return TYPE (declared in
 * `@lunora/server`) whose `extension` field would send symbol-resolution into
 * that package's `.d.ts`, losing the local object literal. Following the receiver
 * keeps us on the project's own `const plugin = definePlugin(...)` declaration,
 * which we then navigate structurally in {@link nextExpressionFromDeclaration}.
 */
const extensionTargetIdentifier = (argument: TsNode): TsNode | undefined => {
    if (Node.isIdentifier(argument)) {
        return argument;
    }

    if (Node.isPropertyAccessExpression(argument)) {
        const receiver = argument.getExpression();

        return Node.isIdentifier(receiver) ? receiver : undefined;
    }

    return undefined;
};

/**
 * The object literal a plugin/extension value exposes its properties on: the
 * literal itself (`const p = { extension: … }`), or the config object passed to a
 * `definePlugin("key", { extension: … })` wrapper (the shape the registry's
 * `ratelimit`/`presence` items ship). Returns `undefined` for anything else.
 */
const pluginConfigObject = (expression: Expression): ObjectLiteralExpression | undefined => {
    if (Node.isObjectLiteralExpression(expression)) {
        return expression;
    }

    if (Node.isCallExpression(expression)) {
        const callee = expression.getExpression();
        let name: string | undefined;

        if (Node.isIdentifier(callee)) {
            name = callee.getText();
        } else if (Node.isPropertyAccessExpression(callee)) {
            name = callee.getName();
        }

        if (name === "definePlugin") {
            const configArgument = expression.getArguments()[1];

            return configArgument && Node.isObjectLiteralExpression(configArgument) ? configArgument : undefined;
        }
    }

    return undefined;
};

/**
 * Resolve a `.extend(...)` argument expression to the `defineSchemaExtension`
 * call it ultimately denotes. Handles the inline call, a same-project
 * identifier (`.extend(myExt)`), and a property access (`.extend(plugin.extension)`)
 * by following symbols to their declarations. Returns `undefined` when the
 * argument resolves into another package (only a `.d.ts` / `node_modules`
 * declaration is reachable) or cannot be resolved locally.
 */

/**
 * Given a declaration the `.extend(...)` argument's symbol points at, return the
 * next expression to keep resolving toward the `defineSchemaExtension(...)` call:
 * the object's named property for `.extend(plugin.extension)`, or the
 * declaration's own initializer for `.extend(myExt)`. Returns `undefined` when
 * the declaration carries nothing further to follow.
 */
const nextExpressionFromDeclaration = (declaration: TsNode, argument: TsNode): Expression | undefined => {
    // `const myExt = defineSchemaExtension(...)`,
    // `const plugin = { extension: defineSchemaExtension(...) }`, or
    // `const plugin = definePlugin("key", { extension: defineSchemaExtension(...) })`.
    const initializer = declarationInitializer(declaration);

    if (!initializer) {
        return undefined;
    }

    // For `.extend(plugin.extension)`, dig the named property off the plugin's
    // config object — unwrapping a `definePlugin(...)` wrapper when present.
    if (Node.isPropertyAccessExpression(argument)) {
        const configObject = pluginConfigObject(initializer);

        return configObject ? objectPropertyInitializer(configObject, argument.getName()) : undefined;
    }

    return initializer;
};

const resolveSchemaExtensionCall = (argument: TsNode): CallExpression | undefined => {
    let current: TsNode | undefined = argument;
    // Bound the symbol-follow loop so a pathological `const a = b; const b = a;`
    // cycle can't spin forever.
    let hops = 0;

    while (current && hops < 32) {
        hops += 1;

        // Inline: `.extend(defineSchemaExtension("k", {...}))`.
        if (isInlineExtensionCall(current)) {
            return current;
        }

        const target = extensionTargetIdentifier(current);
        const symbol = target && Node.isIdentifier(target) ? target.getSymbol() : undefined;
        const declarations = symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? [];
        const first = declarations[0];

        if (!first) {
            return undefined;
        }

        const declarationFile = first.getSourceFile();

        // Cross-package: only a `.d.ts` or a `node_modules` source is reachable.
        // We cannot read the real `defineSchemaExtension(...)` literal, so defer.
        if (declarationFile.isInNodeModules() || declarationFile.isDeclarationFile()) {
            return undefined;
        }

        current = nextExpressionFromDeclaration(first, current);
    }

    return undefined;
};

/** Read the `{ tables: {...}, vectorIndexes?: {...} }` options object off a `defineSchemaExtension(key, options)` call. */
const extensionPartsOf = (call: CallExpression): { key: string; options: ObjectLiteralExpression } | undefined => {
    const [keyArgument, optionsArgument] = call.getArguments();

    if (!keyArgument || !Node.isStringLiteral(keyArgument)) {
        return undefined;
    }

    if (!optionsArgument || !Node.isObjectLiteralExpression(optionsArgument)) {
        return undefined;
    }

    return { key: keyArgument.getLiteralText(), options: optionsArgument };
};

/** Parse the `tables: {...}` property of a `defineSchemaExtension` options object into bare-named {@link TableIR}s. */
const parseExtensionTables = (options: ObjectLiteralExpression): TableIR[] => {
    const tablesProperty = options.getProperty("tables");

    if (!tablesProperty || !Node.isPropertyAssignment(tablesProperty)) {
        return [];
    }

    const tablesObject = tablesProperty.getInitializer();

    if (!tablesObject || !Node.isObjectLiteralExpression(tablesObject)) {
        return [];
    }

    const tables: TableIR[] = [];

    for (const property of tablesObject.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer) {
            continue;
        }

        tables.push(parseTableBuilder(initializer, property.getName()));
    }

    return tables;
};

/** Parse the optional `vectorIndexes: {...}` property of a `defineSchemaExtension` options object (Shape B map). */
const parseExtensionVectorIndexes = (options: ObjectLiteralExpression): VectorIndexIR[] => {
    const property = options.getProperty("vectorIndexes");

    if (!property || !Node.isPropertyAssignment(property)) {
        return [];
    }

    const object = property.getInitializer();

    if (!object || !Node.isObjectLiteralExpression(object)) {
        return [];
    }

    return parseStandaloneVectorIndexes(object);
};

/** Result of merging one `.extend(...)` extension: prefixed tables + prefixed standalone vector indexes. */
interface MergedExtension {
    tables: TableIR[];
    vectorIndexes: VectorIndexIR[];
}

/**
 * Apply runtime namespacing (table prefixing + intra-extension reference
 * rewrite) to an extension's BARE tables + standalone vector indexes — the step
 * shared by the AST path and the package-runtime path ({@link resolvePackageExtension}).
 */
const namespaceExtension = (key: string, bareTables: ReadonlyArray<TableIR>, bareVectorIndexes: ReadonlyArray<VectorIndexIR>): MergedExtension => {
    const bareNames = new Set(bareTables.map((table) => table.name));
    const tables = bareTables.map((table) => namespaceExtensionTable(table, key, bareNames));

    // Standalone vector indexes carry their own bare map key plus a `table`
    // reference; prefix both, matching the runtime merge.
    const vectorIndexes = bareVectorIndexes.map((index) => {
        return { ...index, name: prefixTableName(key, index.name), table: rewriteReference(index.table, key, bareNames) };
    });

    return { tables, vectorIndexes };
};

/** Apply runtime namespacing to one AST-resolved `defineSchemaExtension(...)` options object. */
const mergeExtension = (key: string, options: ObjectLiteralExpression): MergedExtension =>
    namespaceExtension(key, parseExtensionTables(options), parseExtensionVectorIndexes(options));

/**
 * Resolve + merge one `.extend(...)` call into a {@link MergedExtension}, or
 * `undefined` (with a `console.warn`) when the extension can't be resolved from
 * local sources or is malformed. Mirrors how codegen elsewhere warns rather
 * than crashing on inputs it can't statically resolve.
 */
const mergeExtendCall = (extendCall: CallExpression, projectRoot: string | undefined): MergedExtension | undefined => {
    const extendArgument = extendCall.getArguments()[0];

    if (!extendArgument) {
        return undefined;
    }

    const resolved = resolveSchemaExtensionCall(extendArgument);

    if (!resolved) {
        // AST resolution bailed (the extension lives in a published package, only
        // a `.d.ts` is reachable). When we know the project root, fall back to
        // importing the package and introspecting its runtime extension value
        // (Plan 056). Returns `undefined` on any failure → the warn+skip below.
        if (projectRoot !== undefined) {
            const fromPackage = resolvePackageExtension(extendArgument, projectRoot);

            if (fromPackage) {
                return namespaceExtension(fromPackage.key, fromPackage.bareTables, fromPackage.bareVectorIndexes);
            }
        }

        // eslint-disable-next-line no-console -- codegen surfaces a clear, actionable warning when an extension cannot be resolved.
        console.warn(
            `@lunora/codegen: skipping \`.extend(${extendArgument.getText()})\` — its \`defineSchemaExtension(...)\` could not be resolved from local sources, and ${projectRoot === undefined ? "no project root was available to resolve the package" : "the package could not be imported/introspected"}. Extension tables will be absent from the generated types.`,
        );

        return undefined;
    }

    const parts = extensionPartsOf(resolved);

    if (!parts) {
        // eslint-disable-next-line no-console -- malformed extension call; warn rather than crash.
        console.warn(`@lunora/codegen: skipping \`.extend(...)\` — \`defineSchemaExtension\` requires a string \`key\` and an options object literal.`);

        return undefined;
    }

    return mergeExtension(parts.key, parts.options);
};

/**
 * Walk the chained `.extend(arg)` calls wrapping a `defineSchema(...)` call
 * (innermost → outermost) and return the {@link CallExpression}s, in source
 * order. `defineSchema({...}).extend(a).extend(b)` yields `[a-call, b-call]`.
 */
const extendCallsOf = (defineSchemaCall: CallExpression): CallExpression[] => {
    const calls: CallExpression[] = [];
    let current: TsNode = defineSchemaCall;

    // Each chained call is `CallExpression(PropertyAccessExpression(current, name))`.
    // Collect the `.extend(...)` links; transparently step over any other chained
    // builder method (e.g. `.rls("required")`) so a `defineSchema(...).rls(...)
    // .extend(...)` ordering still finds its extensions instead of stopping at
    // the first non-`extend` link.
    for (;;) {
        const parent = current.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        if (parent.getName() === "extend") {
            calls.push(callParent);
        }

        current = callParent;
    }

    return calls;
};

/**
 * Walk the builder chain wrapping `defineSchemaCall` for a `.&lt;methodName>("literal")`
 * link and return its validated string-literal argument, or `undefined` when the
 * method is absent from the chain (found regardless of where it sits, e.g.
 * `defineSchema(...).rls("required").jurisdiction("us").extend(...)`). Shared by
 * {@link jurisdictionOf} and {@link rlsModeOf}, which differ only in the method
 * name, the allowed-literal `Set`, and the diagnostic phrasing. Throws (via
 * {@link diagnosticAt}) on a non-literal argument or an unrecognised literal, so a
 * typo fails loudly rather than silently mis-modelling the schema.
 */
const chainedStringLiteralArgument = <T extends string>(
    defineSchemaCall: CallExpression,
    methodName: string,
    noun: string,
    allowed: ReadonlySet<T>,
    expected: string,
): T | undefined => {
    let current: TsNode = defineSchemaCall;

    for (;;) {
        const parent = current.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        if (parent.getName() === methodName) {
            const argument = callParent.getArguments()[0];

            if (!argument || !Node.isStringLiteral(argument)) {
                throw diagnosticAt(callParent, `\`.${methodName}(...)\` expects a string literal (${expected})`);
            }

            const value = argument.getLiteralText() as T;

            if (!allowed.has(value)) {
                throw diagnosticAt(argument, `unknown ${noun} ${JSON.stringify(value)} — expected ${expected}`);
            }

            return value;
        }

        current = callParent;
    }

    return undefined;
};

/** Recognised Cloudflare DO data-residency jurisdictions — the literals a `.jurisdiction("…")` call may carry. */
const JURISDICTIONS = new Set<NonNullable<SchemaIR["jurisdiction"]>>(["eu", "fedramp", "us"]);

/**
 * The `.jurisdiction("…")` link's literal on the chain wrapping a `defineSchema(...)`
 * call (`defineSchema(...).rls(...).jurisdiction("us").extend(...)`), or `undefined`
 * when absent. Throws on an unrecognised literal so a typo fails loudly rather than
 * emitting an invalid jurisdiction. See {@link chainedStringLiteralArgument}.
 */
const jurisdictionOf = (defineSchemaCall: CallExpression): SchemaIR["jurisdiction"] =>
    chainedStringLiteralArgument(defineSchemaCall, "jurisdiction", "jurisdiction", JURISDICTIONS, '"eu", "us", or "fedramp"');

/** Recognised `.rls(...)` mode literals — currently only `"required"`. */
const RLS_MODES = new Set<NonNullable<SchemaIR["rlsMode"]>>(["required"]);

/**
 * The `.rls("required")` link's literal on the chain wrapping a `defineSchema(...)`
 * call (`defineSchema(...).rls("required").extend(...)`), or `undefined` when absent.
 * Throws on an unrecognised literal so a typo fails loudly rather than silently
 * treating the schema as RLS-unenforced. See {@link chainedStringLiteralArgument}.
 */
const rlsModeOf = (defineSchemaCall: CallExpression): SchemaIR["rlsMode"] =>
    chainedStringLiteralArgument(defineSchemaCall, "rls", "rls mode", RLS_MODES, '"required"');

/** Parse the base `defineSchema({ table: defineTable(...) })` object literal into {@link TableIR}s. */
const parseBaseTables = (object: ObjectLiteralExpression): TableIR[] => {
    const tables: TableIR[] = [];

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (initializer) {
            const name = property.getName();

            assertTableNameAllowed(name, property.getNameNode());
            tables.push(parseTableBuilder(initializer, name));
        }
    }

    return tables;
};

/**
 * Merge every chained `.extend(...)` extension into `tables` (mutated in place)
 * and return the extension-contributed standalone vector indexes. Extension
 * tables are auto-prefixed with the extension key and intra-extension
 * references rewritten, mirroring the runtime `mergeSchemaExtension`.
 * Cross-package extensions (only reachable as a `.d.ts`) are skipped with a
 * warning — a deferred phase. Throws on a real post-prefix table collision.
 */
const applyExtensions = (defineSchemaCall: CallExpression, tables: TableIR[], projectRoot: string | undefined): VectorIndexIR[] => {
    const existingTableNames = new Set(tables.map((table) => table.name));
    const vectorIndexes: VectorIndexIR[] = [];

    for (const extendCall of extendCallsOf(defineSchemaCall)) {
        const merged = mergeExtendCall(extendCall, projectRoot);

        if (!merged) {
            continue;
        }

        for (const table of merged.tables) {
            if (existingTableNames.has(table.name)) {
                throw diagnosticAt(
                    extendCall,
                    `defineSchema(...).extend(...): table "${table.name}" already exists — another extension with the same key already contributed it.`,
                );
            }

            existingTableNames.add(table.name);
            tables.push(table);
        }

        vectorIndexes.push(...merged.vectorIndexes);
    }

    return vectorIndexes;
};

/**
 * Load `&lt;projectRoot>/lunora/schema.ts`, find `defineSchema({...})`, and
 * return a structural IR. Throws if the file or call cannot be found.
 */
const discoverSchema = (project: Project, schemaPath: string, projectRoot?: string): SchemaIR => {
    const file: SourceFile = project.addSourceFileAtPath(schemaPath);

    const defineSchemaCall = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
        const callee = call.getExpression();

        return Node.isIdentifier(callee) && callee.getText() === "defineSchema";
    });

    if (!defineSchemaCall) {
        throw new LunoraError("INTERNAL", `defineSchema() not found in ${schemaPath}`);
    }

    const argument = defineSchemaCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(defineSchemaCall, "defineSchema() expects an object literal");
    }

    const tables: TableIR[] = parseBaseTables(argument);

    // Standalone vector indexes live in the optional second argument (Shape B).
    const standaloneArgument = defineSchemaCall.getArguments()[1];
    const standaloneVectorIndexes =
        standaloneArgument && Node.isObjectLiteralExpression(standaloneArgument) ? parseStandaloneVectorIndexes(standaloneArgument) : [];

    // Merge chained `.extend(...)` extensions, mutating `tables` and collecting
    // their standalone vector indexes.
    const extensionStandaloneVectorIndexes = applyExtensions(defineSchemaCall, tables, projectRoot);

    // Flatten inline Shape A indexes (hoisted with their owning table) plus Shape B
    // plus extension-contributed standalone vector indexes.
    const vectorIndexes: VectorIndexIR[] = [...tables.flatMap((table) => table.vectorIndexes), ...standaloneVectorIndexes, ...extensionStandaloneVectorIndexes];

    return { jurisdiction: jurisdictionOf(defineSchemaCall), rlsMode: rlsModeOf(defineSchemaCall), tables, vectorIndexes };
};

export default discoverSchema;
