import type { CallExpression, Node as TsNode, Project, Type } from "ts-morph";
import { Node } from "ts-morph";

import type { TableWriteIR } from "../ir";
import { collectCallRows, isDatabaseAccessor } from "./ast";
import { callSiteScopeOf } from "./attribution";

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

/** The {@link TableWriteIR.table} an unreadable target (an untyped id, a non-literal name) is recorded under. */
const UNREADABLE_TABLE = "";

/** One table write: the method, and the tables it targets — `[UNREADABLE_TABLE]` when they cannot be read. */
interface Write {
    method: string;
    tables: ReadonlyArray<string>;
}

/** The tables a `ctx.db.<method>(first, …)` write names, or `undefined` when `method` is not a write. */
const databaseWrite = (method: string, first: TsNode | undefined): Write | undefined => {
    if (BY_NAME.has(method)) {
        return { method, tables: [first !== undefined && Node.isStringLiteral(first) ? first.getLiteralText() : UNREADABLE_TABLE] };
    }

    if (BY_ID.has(method) || method === "deleteMany" || method === "patchMany") {
        const tables = first === undefined ? [] : tablesOfIdArgument(first, method);

        return { method, tables: tables.length === 0 ? [UNREADABLE_TABLE] : tables };
    }

    return undefined;
};

/** The {@link Write} one call makes, or `undefined` when it is not a table write. */
const writeOf = (call: CallExpression): Write | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();

    if (isDatabaseAccessor(receiver)) {
        return databaseWrite(method, call.getArguments()[0]);
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
 * and the `ctx.db.<table>.*` facade, each with its `CallSiteScope`. A by-id
 * write reads its table off the id's `Id<"table">` type through the type checker:
 * a union id (`Id<"a"> | Id<"b">`) gives one record per table, and an untyped id
 * (a plain `string`) one record with `table: ""`.
 */
const discoverTableWrites = (project: Project, lunoraDirectory: string): TableWriteIR[] =>
    collectCallRows(project, lunoraDirectory, (call, file): TableWriteIR[] | undefined => {
        const write = writeOf(call);

        if (write === undefined) {
            return undefined;
        }

        const scope = callSiteScopeOf(call);
        const line = call.getStartLineNumber();

        return write.tables.map((table) => {
            return { file, line, method: write.method, scope, table };
        });
    });

export default discoverTableWrites;
