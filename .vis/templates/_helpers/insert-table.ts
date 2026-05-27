/**
 * AST-merge helper for `cirrus-table` — kept in `_helpers/` so the tests
 * under `tests/vis-templates/` can import it without pulling in the vis
 * runtime (`@visulima/vis/generate`).
 */
import type { CallExpression, PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

export type InsertTableResult = { ok: true; text: string } | { ok: false; reason: "duplicate" | "no-define-schema" | "non-object-argument" };

/**
 * AST-merge a `&lt;tableName>: defineTable({ ... })` entry into an existing
 * `defineSchema({ ... })` call.
 *
 * Returns a tagged result rather than throwing so callers can render a
 * helpful message per failure mode.
 *
 * Note: only the literal identifier `defineSchema` is matched. If a user
 * aliases the import (`import { defineSchema as ds }`) this will report
 * `no-define-schema`; that's an edge case we accept until someone hits it.
 */
export const insertTableIntoSchema = (source: string, tableName: string): InsertTableResult => {
    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    let defineSchemaCall: CallExpression | undefined;

    for (const call of callExpressions) {
        if (call.getExpression().getText() === "defineSchema") {
            defineSchemaCall = call;
            break;
        }
    }

    if (!defineSchemaCall) {
        return { ok: false, reason: "no-define-schema" };
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { ok: false, reason: "non-object-argument" };
    }

    const tablesObject = tablesArgument.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    for (const property of tablesObject.getProperties()) {
        if (property.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = property as PropertyAssignment;

            if (assignment.getNameNode().getText() === tableName) {
                return { ok: false, reason: "duplicate" };
            }
        }
    }

    tablesObject.addPropertyAssignment({
        initializer: `defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    })`,
        name: tableName,
    });

    return { ok: true, text: sourceFile.getFullText() };
};
