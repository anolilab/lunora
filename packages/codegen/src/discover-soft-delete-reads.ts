import type { Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived } from "./argument-taint";
import { propertyInitializer, readTargetOf } from "./discover-ast";
import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SoftDeleteReadIR } from "./ir";

/**
 * Reduce one exported procedure declaration to the `includeDeleted` list reads
 * inside its body. Classify-then-walk (the {@link classifyProcedureCall} shape
 * the mask/rls feeders use): the classification gives the procedure's visibility
 * for free, then every `ctx.db` list read passing `includeDeleted` is recorded.
 * Only a hardcoded `true` (always resurfaces soft-deleted rows) or an arg-derived
 * toggle (any caller can flip it) is kept — a literal `false` or a
 * server-trusted/`ctx`-scoped value is a deliberate, non-spoofable choice and is
 * skipped, so the lint never fires on a benign read.
 */
const softDeleteReadsInDeclaration = (declaration: TsNode, relativePath: string): SoftDeleteReadIR[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const initializer = declaration.getInitializer();
    const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

    if (!classified) {
        return [];
    }

    const rows: SoftDeleteReadIR[] = [];

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const target = readTargetOf(call);

        if (target === undefined) {
            continue;
        }

        const value = propertyInitializer(target.options, "includeDeleted");

        if (value === undefined) {
            continue;
        }

        const hardcodedTrue = Node.isTrueLiteral(value);
        const fromArgs = !hardcodedTrue && isArgumentDerived(value);

        if (!hardcodedTrue && !fromArgs) {
            continue;
        }

        rows.push({
            exportName: declaration.getName(),
            file: relativePath,
            fromArgs,
            hardcodedTrue,
            line: call.getStartLineNumber(),
            table: target.table,
            visibility: classified.visibility,
        });
    }

    return rows;
};

/**
 * Discover `ctx.db.<table>.findMany({ includeDeleted })` list reads under the
 * lunora source directory whose `includeDeleted` is either a hardcoded `true` or
 * derived from the handler's `args` — the `soft_delete_include_deleted_from_args`
 * lint input. The lint joins each row's `table` against the schema's
 * soft-delete tables and its `visibility` against `.public()` before flagging,
 * so this feeder stays table-agnostic and records every classified procedure's
 * `includeDeleted` reads regardless of kind.
 */
const discoverSoftDeleteReads = (project: Project, lunoraDirectory: string): SoftDeleteReadIR[] => {
    const rows: SoftDeleteReadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                rows.push(...softDeleteReadsInDeclaration(declaration, relativePath));
            }
        }
    }

    return rows;
};

export default discoverSoftDeleteReads;
