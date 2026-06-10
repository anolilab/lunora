/**
 * Minimal `defineSchema({ … })` reader for the `cirrus-collections` generator:
 * enumerate each table, its `shardBy(field)` (if any), and its declared column
 * names — enough to scaffold a `@cirrus/db` `defineCollections` call.
 */
import type { ObjectLiteralExpression, PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

export interface SchemaTable {
    columns: string[];
    name: string;
    shardBy?: string;
}

/** Parse the tables out of a `cirrus/schema.ts` source string. */
export const parseSchemaTables = (source: string): SchemaTable[] => {
    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    const defineSchemaCall = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getText() === "defineSchema");

    const tablesArgument = defineSchemaCall?.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return [];
    }

    const tables: SchemaTable[] = [];

    for (const property of (tablesArgument as ObjectLiteralExpression).getProperties()) {
        if (property.getKind() !== SyntaxKind.PropertyAssignment) {
            continue;
        }

        const assignment = property as PropertyAssignment;
        const name = assignment.getName().replaceAll(/["']/g, "");
        const initializerText = assignment.getInitializer()?.getText() ?? "";

        const shardMatch = /\.shardBy\(\s*["']([^"']+)["']\s*\)/u.exec(initializerText);

        // Column names = the keys of the `defineTable({ … })` argument object
        // (the innermost call of the `defineTable(...).shardBy(...).index(...)` chain).
        const columns: string[] = [];
        const defineTableCall = assignment
            .getInitializer()
            ?.getDescendantsOfKind(SyntaxKind.CallExpression)
            .find((call) => call.getExpression().getText() === "defineTable");
        const tableShape = defineTableCall?.getArguments()[0];

        if (tableShape?.getKind() === SyntaxKind.ObjectLiteralExpression) {
            for (const column of (tableShape as ObjectLiteralExpression).getProperties()) {
                if (column.getKind() === SyntaxKind.PropertyAssignment) {
                    columns.push((column as PropertyAssignment).getName().replaceAll(/["']/g, ""));
                }
            }
        }

        tables.push({ columns, name, ...(shardMatch?.[1] === undefined ? {} : { shardBy: shardMatch[1] }) });
    }

    return tables;
};
