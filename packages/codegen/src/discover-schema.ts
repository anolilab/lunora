import type { Expression, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { IndexIR, SchemaIR, SearchIndexIR, TableIR, ValidatorIR, VectorIndexIR } from "./ir.js";
import { parseObjectShape } from "./parse-validator.js";

const VECTOR_METRICS = new Set(["cosine", "dot-product", "euclidean"]);

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

const asMetric = (value: string | undefined): VectorIndexIR["metric"] => value && VECTOR_METRICS.has(value) ? (value as VectorIndexIR["metric"]) : undefined;

const parseTableBuilder = (expression: Expression, name: string): TableIR => {
    const indexes: IndexIR[] = [];
    const searchIndexes: SearchIndexIR[] = [];
    const vectorIndexes: VectorIndexIR[] = [];
    let shardMode: TableIR["shardMode"] = "root";
    let shape: Record<string, ValidatorIR> = {};
    let current: Expression = expression;

    // Unwind the chain: e.g. defineTable({...}).index(...).shardBy("x")
    while (Node.isCallExpression(current)) {
        const callee = current.getExpression();
        const args = current.getArguments();

        if (Node.isPropertyAccessExpression(callee)) {
            const method = callee.getName();

            switch (method) {
                case "global": {
                    shardMode = "global";

                    break;
                }

                case "index": {
                    const indexName = args[0];
                    const fieldsExpression = args[1];
                    const optionsExpression = args[2];
                    let unique = false;

                    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
                        const property = optionsExpression.getProperty("unique");

                        if (property && Node.isPropertyAssignment(property)) {
                            unique = property.getInitializer()?.getText() === "true";
                        }
                    }

                    const fields
                        = fieldsExpression && Node.isArrayLiteralExpression(fieldsExpression)
                            ? fieldsExpression
                                .getElements()
                                .filter((element): element is Expression => Node.isStringLiteral(element))
                                .map((element) =>
                                    (element as ReturnType<typeof fieldsExpression.getElements>[number] & { getLiteralText: () => string }).getLiteralText(),
                                )
                            : [];

                    indexes.push({
                        fields,
                        name: indexName && Node.isStringLiteral(indexName) ? indexName.getLiteralText() : "_unnamed_",
                        unique,
                    });

                    break;
                }

                case "searchIndex": {
                    const indexName = args[0];
                    const optionsExpression = args[1];
                    let field = "_unknown_";
                    let filterFields: string[] | undefined;

                    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
                        const fieldProperty = optionsExpression.getProperty("field");

                        if (fieldProperty && Node.isPropertyAssignment(fieldProperty)) {
                            const initializer = fieldProperty.getInitializer();

                            if (initializer && Node.isStringLiteral(initializer)) {
                                field = initializer.getLiteralText();
                            }
                        }

                        const filterProperty = optionsExpression.getProperty("filterFields");

                        if (filterProperty && Node.isPropertyAssignment(filterProperty)) {
                            const initializer = filterProperty.getInitializer();

                            if (initializer && Node.isArrayLiteralExpression(initializer)) {
                                filterFields = initializer
                                    .getElements()
                                    .filter((element): element is Expression & { getLiteralText: () => string } => Node.isStringLiteral(element))
                                    .map((element) => element.getLiteralText());
                            }
                        }
                    }

                    searchIndexes.push({
                        field,
                        filterFields,
                        name: indexName && Node.isStringLiteral(indexName) ? indexName.getLiteralText() : "_unnamed_",
                    });

                    break;
                }

                case "shardBy": {
                    const field = args[0];

                    shardMode = { field: field && Node.isStringLiteral(field) ? field.getLiteralText() : "_unknown_", kind: "shardBy" };

                    break;
                }

                case "vectorize": {
                    const fieldArgument = args[0];
                    const optionsExpression = args[1];
                    const field = fieldArgument && Node.isStringLiteral(fieldArgument) ? fieldArgument.getLiteralText() : "_unknown_";

                    if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
                        vectorIndexes.push({
                            dimensions: getNumberProperty(optionsExpression, "dimensions"),
                            field,
                            metadata: getStringArrayProperty(optionsExpression, "metadata"),
                            metric: asMetric(getStringProperty(optionsExpression, "metric")),
                            name: getStringProperty(optionsExpression, "index") ?? "_unnamed_",
                            table: name,
                        });
                    }

                    break;
                }

                default: {
                    break;
                }
            }

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

    return { indexes, name, searchIndexes, shape, shardMode, vectorIndexes };
};

/**
 * Parse the optional second argument to `defineSchema(...)` — a map of index
 * name -> `defineVectorIndex({...})` call (DSL Shape B). The embedded text
 * source is a `select` function, so `field`/`metadata` stay undefined here.
 */
const parseStandaloneVectorIndexes = (object: ObjectLiteralExpression): VectorIndexIR[] => {
    const result: VectorIndexIR[] = [];

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer || !Node.isCallExpression(initializer)) {
            continue;
        }

        const callee = initializer.getExpression();

        if (!Node.isIdentifier(callee) || callee.getText() !== "defineVectorIndex") {
            continue;
        }

        const optionsExpression = initializer.getArguments()[0];
        let table = "_unknown_";

        if (optionsExpression && Node.isObjectLiteralExpression(optionsExpression)) {
            const sourceProperty = optionsExpression.getProperty("source");

            if (sourceProperty && Node.isPropertyAssignment(sourceProperty)) {
                const sourceInitializer = sourceProperty.getInitializer();

                if (sourceInitializer && Node.isObjectLiteralExpression(sourceInitializer)) {
                    table = getStringProperty(sourceInitializer, "table") ?? table;
                }
            }

            const nameNode = property.getNameNode();
            const indexName = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();

            result.push({
                dimensions: getNumberProperty(optionsExpression, "dimensions"),
                metric: asMetric(getStringProperty(optionsExpression, "metric")),
                name: indexName,
                table,
            });
        }
    }

    return result;
};

/**
 * Load `<projectRoot>/cirrus/schema.ts`, find `defineSchema({...})`, and
 * return a structural IR. Throws if the file or call cannot be found.
 */
export const discoverSchema = (project: Project, schemaPath: string): SchemaIR => {
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
    const standaloneVectorIndexes
        = standaloneArgument && Node.isObjectLiteralExpression(standaloneArgument) ? parseStandaloneVectorIndexes(standaloneArgument) : [];

    // Flatten inline Shape A indexes (hoisted with their owning table) plus Shape B.
    const vectorIndexes: VectorIndexIR[] = [...tables.flatMap((table) => table.vectorIndexes), ...standaloneVectorIndexes];

    return { tables, vectorIndexes };
};
