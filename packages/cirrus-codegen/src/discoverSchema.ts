import type { Expression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { IndexIR, SchemaIR, SearchIndexIR, TableIR, ValidatorIR } from "./ir.js";
import { parseObjectShape } from "./parseValidator.js";

const parseTableBuilder = (expression: Expression, name: string): TableIR => {
    const indexes: IndexIR[] = [];
    const searchIndexes: SearchIndexIR[] = [];
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

    return { indexes, name, searchIndexes, shape, shardMode };
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

    return { tables };
};
