import type { Expression, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { IndexIR, RelationIR, SchemaIR, SearchIndexIR, TableIR, ValidatorIR, VectorIndexIR } from "./ir.js";
import { parseObjectShape } from "./parse-validator.js";

const VECTOR_METRICS = new Set(["cosine", "dot-product", "euclidean"]);
const ON_DELETE_ACTIONS = new Set(["cascade", "restrict", "set null"]);

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
                throw new Error(`@cirrus/codegen: \`unique\` must be a literal \`true\` or \`false\`, got ${JSON.stringify(initializer.getText())}`);
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

/** Accumulator the builder-chain walk mutates as it unwinds a `defineTable(...)` chain. */
interface TableBuilderAccumulator {
    indexes: IndexIR[];
    relations: RelationIR[];
    searchIndexes: SearchIndexIR[];
    shardMode: TableIR["shardMode"];
    vectorIndexes: VectorIndexIR[];
}

/** Apply one chained method call (`.index`, `.shardBy`, …) to the accumulator. */
const applyTableMethod = (accumulator: TableBuilderAccumulator, method: string, args: ReadonlyArray<Node>, name: string): void => {
    switch (method) {
        case "global": {
            accumulator.shardMode = "global";

            break;
        }

        case "index": {
            accumulator.indexes.push(parseIndexCall(args));

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
    const accumulator: TableBuilderAccumulator = { indexes: [], relations: [], searchIndexes: [], shardMode: "root", vectorIndexes: [] };
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

    return {
        indexes: accumulator.indexes,
        name,
        relations: accumulator.relations,
        searchIndexes: accumulator.searchIndexes,
        shape,
        shardMode: accumulator.shardMode,
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
 * Load `&lt;projectRoot>/cirrus/schema.ts`, find `defineSchema({...})`, and
 * return a structural IR. Throws if the file or call cannot be found.
 */
const discoverSchema = (project: Project, schemaPath: string): SchemaIR => {
    const file: SourceFile = project.addSourceFileAtPath(schemaPath);

    const defineSchemaCall = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
        const callee = call.getExpression();

        return Node.isIdentifier(callee) && callee.getText() === "defineSchema";
    });

    if (!defineSchemaCall) {
        throw new Error(`defineSchema() not found in ${schemaPath}`);
    }

    const argument = defineSchemaCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw new Error("defineSchema() expects an object literal");
    }

    const tables: TableIR[] = [];

    for (const property of argument.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer) {
            continue;
        }

        tables.push(parseTableBuilder(initializer, property.getName()));
    }

    // Standalone vector indexes live in the optional second argument (Shape B).
    const standaloneArgument = defineSchemaCall.getArguments()[1];
    const standaloneVectorIndexes =
        standaloneArgument && Node.isObjectLiteralExpression(standaloneArgument) ? parseStandaloneVectorIndexes(standaloneArgument) : [];

    // Flatten inline Shape A indexes (hoisted with their owning table) plus Shape B.
    const vectorIndexes: VectorIndexIR[] = [...tables.flatMap((table) => table.vectorIndexes), ...standaloneVectorIndexes];

    return { tables, vectorIndexes };
};

export default discoverSchema;
