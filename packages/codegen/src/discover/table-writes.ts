import type { CallExpression, Node as TsNode, Project, Type } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { TableWriteIR } from "../ir";
import { exportAttributionsOf, isDatabaseAccessor, listLunoraSourceFiles, lunoraRelativePath } from "./ast";

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

/**
 * The tables an `Id<"table">` type brands (`string & { readonly __table: "table" }`),
 * or `[]` when it is not one. Nullish members are dropped first (`Id<"a"> |
 * undefined`), and a union of ids (`Id<"a"> | Id<"b">`) yields every member's
 * table — its `__table` is the union `"a" | "b"`.
 */
const tablesOfIdType = (type: Type, at: TsNode): string[] => {
    const brand = type.getNonNullableType().getProperty("__table")?.getTypeAtLocation(at);

    if (brand === undefined) {
        return [];
    }

    const members = brand.isUnion() ? brand.getUnionTypes() : [brand];
    const tables = members.map((member) => member.getLiteralValue()).filter((value): value is string => typeof value === "string");

    // A member that is not a string literal (`Id<string>`) makes the set unreadable.
    return tables.length === members.length ? tables : [];
};

/** The tables a by-id argument addresses: the id itself, an array of ids, or an array of `{ id }` (`patchMany`). */
const tablesOfIdArgument = (argument: TsNode, method: string): string[] => {
    const type = argument.getType();

    if (method === "deleteMany" || method === "patchMany") {
        const element = type.getArrayElementType();

        if (element === undefined) {
            return [];
        }

        const idType = method === "patchMany" ? element.getProperty("id")?.getTypeAtLocation(argument) : element;

        return idType === undefined ? [] : tablesOfIdType(idType, argument);
    }

    return tablesOfIdType(type, argument);
};

/** The tables a `ctx.db.<method>(first, …)` write names, or `undefined` when `method` is not a write. */
const databaseWriteTables = (method: string, first: TsNode | undefined): string[] | undefined => {
    if (BY_NAME.has(method)) {
        return [first !== undefined && Node.isStringLiteral(first) ? first.getLiteralText() : ""];
    }

    if (BY_ID.has(method) || method === "deleteMany" || method === "patchMany") {
        const tables = first === undefined ? [] : tablesOfIdArgument(first, method);

        return tables.length === 0 ? [""] : tables;
    }

    return undefined;
};

/**
 * The `{ method, tables }` one call writes, or `undefined` when it is not a table
 * write. `tables` is `[""]` when the table can't be read (an untyped id, a
 * non-literal name), so the write is still recorded.
 */
const writeOf = (call: CallExpression): { method: string; tables: string[] } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();

    if (isDatabaseAccessor(receiver)) {
        const tables = databaseWriteTables(method, call.getArguments()[0]);

        return tables === undefined ? undefined : { method, tables };
    }

    // `ctx.db.<table>.<method>(…)` — the facade puts the table in the receiver.
    if (FACADE_WRITES.has(method) && Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) {
        return { method, tables: [receiver.getName()] };
    }

    return undefined;
};

/**
 * Discover every table write besides a plain `ctx.db.insert("table", …)` (that is
 * `discoverInserts`): by-id writes (`patch`/`replace`/`delete`/…), batch writes,
 * and the `ctx.db.<table>.*` facade. A by-id write reads its table off the id's
 * `Id<"table">` type through the type checker, so `table` is `""` when the id
 * is untyped (a plain `string`), and a union id (`Id<"a"> | Id<"b">`) records one
 * write per table. Attribution follows `discoverInserts`: once per export that
 * reaches the call, or `exportName: ""` plus the helper's name when none does.
 */
const discoverTableWrites = (project: Project, lunoraDirectory: string): TableWriteIR[] => {
    const writes: TableWriteIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const file = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const write = writeOf(call);

            if (write === undefined) {
                continue;
            }

            for (const attribution of exportAttributionsOf(call)) {
                for (const table of write.tables) {
                    writes.push({ ...attribution, file, line: call.getStartLineNumber(), method: write.method, table });
                }
            }
        }
    }

    return writes;
};

export default discoverTableWrites;
