import type { CallExpression, Node as TsNode, Project, Type } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { TableWriteIR } from "../ir";
import { enclosingExportName, isDatabaseAccessor, listLunoraSourceFiles, lunoraRelativePath } from "./ast";

/** `ctx.db.<method>(id, …)` writes whose first argument is an `Id<"table">`. */
const BY_ID = new Set(["delete", "hardDelete", "patch", "replace", "restore"]);

/** `ctx.db.<method>("table", …)` writes that name the table first. `insert` is `discoverInserts`'. */
const BY_NAME = new Set(["insertMany", "insertManyUnsafe", "patchWhere"]);

/** `ctx.db.<table>.<method>(…)` facade writes — the table is the receiver's property name. */
const FACADE_WRITES = new Set([
    "delete",
    "deleteMany",
    "hardDelete",
    "insert",
    "insertMany",
    "patch",
    "patchMany",
    "replace",
    "restore",
    "upsert",
    "upsertMany",
]);

/** The table an `Id<"table">` type brands (`string & { readonly __table: "table" }`), or `""` when it is not one. */
const tableOfIdType = (type: Type, at: TsNode): string => {
    const brand = type.getProperty("__table")?.getTypeAtLocation(at);
    const value = brand?.getLiteralValue();

    return typeof value === "string" ? value : "";
};

/** The table a by-id argument addresses: the id itself, an array of ids, or an array of `{ id }` (`patchMany`). */
const tableOfIdArgument = (argument: TsNode, method: string): string => {
    const type = argument.getType();

    if (method === "deleteMany" || method === "patchMany") {
        const element = type.getArrayElementType();

        if (element === undefined) {
            return "";
        }

        const idType = method === "patchMany" ? element.getProperty("id")?.getTypeAtLocation(argument) : element;

        return idType === undefined ? "" : tableOfIdType(idType, argument);
    }

    return tableOfIdType(type, argument);
};

/** The `{ method, table }` one call writes, or `undefined` when it is not a table write. */
const writeOf = (call: CallExpression): { method: string; table: string } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();
    const [first] = call.getArguments();

    if (isDatabaseAccessor(receiver)) {
        if (BY_NAME.has(method)) {
            return { method, table: first !== undefined && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
        }

        if (BY_ID.has(method) || method === "deleteMany" || method === "patchMany") {
            return { method, table: first === undefined ? "" : tableOfIdArgument(first, method) };
        }

        return undefined;
    }

    // `ctx.db.<table>.<method>(…)` — the facade puts the table in the receiver.
    if (FACADE_WRITES.has(method) && Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) {
        return { method, table: receiver.getName() };
    }

    return undefined;
};

/**
 * Discover every table write besides a plain `ctx.db.insert("table", …)` (that is
 * `discoverInserts`): by-id writes (`patch`/`replace`/`delete`/…), batch writes,
 * and the `ctx.db.<table>.*` facade. A by-id write reads its table off the id's
 * `Id<"table">` type through the type checker, so `table` is `""` when the id
 * is untyped (a plain `string`). Calls outside an exported declaration are
 * skipped, as `discoverInserts` does.
 */
const discoverTableWrites = (project: Project, lunoraDirectory: string): TableWriteIR[] => {
    const writes: TableWriteIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const file = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const write = writeOf(call);
            const exportName = write === undefined ? "" : enclosingExportName(call);

            if (write !== undefined && exportName !== "") {
                writes.push({ exportName, file, line: call.getStartLineNumber(), method: write.method, table: write.table });
            }
        }
    }

    return writes;
};

export default discoverTableWrites;
