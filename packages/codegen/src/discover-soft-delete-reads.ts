import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived } from "./argument-taint";
import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SoftDeleteReadIR } from "./ir";

/**
 * List reads whose options object honours `includeDeleted`. Only `findMany` /
 * `findFirst` / `findFirstOrThrow` take an options object that resurfaces
 * soft-deleted rows — the by-id `get` is id-only and the fluent `query(...)`
 * reader carries no options object, so both are excluded (mirrors the
 * `includeDeleted` semantics documented on `TableDefinition.softDeleteMode`).
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany"]);

/**
 * The `(table, options)` a `ctx.db` list read addresses, or `undefined` when the
 * call isn't one. Matched by receiver **shape** (not import origin), fail-closed,
 * in both surface forms Lunora exposes. Facade form
 * `ctx.db.<table>.findMany(options?)` — the form real app code writes — puts the
 * table in the receiver's property name and the options object at argument 0.
 * Table-arg form `ctx.db.findMany("table", options?)` puts the table in the
 * string-literal argument 0 and the options object at argument 1. `table` is `""`
 * when the table-arg form's first argument isn't a string literal (a dynamic
 * table — not lintable).
 */
const readTargetOf = (call: CallExpression): { options: TsNode | undefined; table: string } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !READ_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    // Table-arg form: the receiver is `ctx.db` (property named `db`) or a bare `db`.
    if ((Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db")) {
        const first = call.getArguments()[0];

        return { options: call.getArguments()[1], table: first && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = (Node.isPropertyAccessExpression(inner) && inner.getName() === "db") || (Node.isIdentifier(inner) && inner.getText() === "db");

        if (onDatabase) {
            return { options: call.getArguments()[0], table: receiver.getName() };
        }
    }

    return undefined;
};

/** The initializer expression of a named property on an options object literal, or `undefined` when absent / not a plain assignment. */
const optionValue = (options: TsNode | undefined, key: string): TsNode | undefined => {
    if (!options || !Node.isObjectLiteralExpression(options)) {
        return undefined;
    }

    const property = options.getProperty(key);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

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

        const value = optionValue(target.options, "includeDeleted");

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
