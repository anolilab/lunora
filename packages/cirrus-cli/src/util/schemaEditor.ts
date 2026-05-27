/**
 * Schema mutation helpers. The interesting one is {@link appendTableToSchema},
 * which uses ts-morph to add a new property to the `defineSchema({ ... })`
 * call in `cirrus/schema.ts`. We do AST-level editing (rather than text-level
 * regex) so we preserve formatting, comments and trailing-comma idioms.
 */
import { type CallExpression, Project, type PropertyAssignment, SyntaxKind } from "ts-morph";

/**
 * Render the default `defineTable({ ... })` block for the named table. Used
 * when we have to fall back to "couldn't insert, here's the source — paste
 * it yourself".
 */
export const formatTableBlock = (tableName: string): string => {
    return `    ${tableName}: defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    }),`;
};

/**
 * Insert a new table property into the `defineSchema({ ... })` call inside
 * the given schema source. Returns the rewritten source, or `undefined`
 * if no `defineSchema` call could be located.
 *
 * The caller is responsible for not double-adding a table that already
 * exists (we don't error here — that's a friendlier concern higher up).
 */

export const appendTableToSchema = (source: string, tableName: string, _block: string): string | undefined => {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
            allowJs: true,
        },
    });

    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    // Find the call expression `defineSchema(...)` and pull its first arg.
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    let defineSchemaCall: CallExpression | undefined;

    for (const call of callExpressions) {
        const expression = call.getExpression();

        if (expression.getText() === "defineSchema") {
            defineSchemaCall = call;
            break;
        }
    }

    if (!defineSchemaCall) {
        return undefined;
    }

    const args = defineSchemaCall.getArguments();
    const tablesArg = args[0];

    if (tablesArg?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return undefined;
    }

    const tablesObject = tablesArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    // Bail if a property with this name already exists — caller handles the
    // collision case, but we double-check defensively.
    for (const property of tablesObject.getProperties()) {
        if (property.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = property as PropertyAssignment;
            const initializer = assignment.getNameNode().getText();

            if (initializer === tableName) {
                return undefined;
            }
        }
    }

    tablesObject.addPropertyAssignment({
        name: tableName,
        initializer: `defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    })`,
    });

    return sourceFile.getFullText();
};
