import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, VariableDeclarationKind } from "ts-morph";

import type { TableWriteIR } from "../ir";
import { collectCallRows } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { isDatabaseAccessor } from "./database-calls";

/** `ctx.db.<method>("table", …)` writes that name the table first. `insert` is `discoverInserts`'. */
const BY_NAME = new Set([
    "delete",
    "deleteMany",
    "hardDelete",
    "insertMany",
    "insertManyUnsafe",
    "patch",
    "patchIf",
    "patchMany",
    "patchWhere",
    "replace",
    "restore",
]);

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

/** The {@link TableWriteIR.table} an unreadable target (an untyped id, a non-literal name) is recorded under. */
const UNREADABLE_TABLE = "";

/** One table write: the method, and the tables it targets — `[UNREADABLE_TABLE]` when they cannot be read. */
interface Write {
    /** See {@link TableWriteIR.fields}. */
    fields?: string[];
    method: string;
    tables: ReadonlyArray<string>;
}

/**
 * The fields a `patch` writes: the keys of its object-literal argument (the third,
 * after the table and id). `undefined` for any other method, and when the argument
 * is not an object literal or spreads one, since then the keys cannot be read.
 */
const patchedFieldsOf = (call: CallExpression, method: string, bodyIndex: number): string[] | undefined => {
    if (method !== "patch") {
        return undefined;
    }

    const patch = call.getArguments()[bodyIndex];

    if (patch === undefined || !Node.isObjectLiteralExpression(patch)) {
        return undefined;
    }

    const keys: string[] = [];

    for (const property of patch.getProperties()) {
        if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) {
            return undefined;
        }

        keys.push(property.getName());
    }

    return keys;
};

/**
 * The tables a first argument may name: a string literal, a `const` bound to one, or an expression whose type is a
 * literal or a union of literals (a `"notes" | "todos"` parameter may write either). An assertion (`x as "posts"`)
 * is a claim about the value, not proof of it, so it is unreadable. `undefined` when no table can be read.
 */
const tablesOfFirst = (first: TsNode | undefined): string[] | undefined => {
    if (first === undefined || Node.isAsExpression(first) || Node.isTypeAssertion(first) || Node.isSatisfiesExpression(first)) {
        return undefined;
    }

    if (Node.isStringLiteral(first)) {
        return [first.getLiteralText()];
    }

    if (Node.isIdentifier(first)) {
        const declaration = first.getSymbol()?.getDeclarations()[0];

        if (
            declaration !== undefined &&
            Node.isVariableDeclaration(declaration) &&
            declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const
        ) {
            const initializer = declaration.getInitializer();

            if (initializer !== undefined) {
                return tablesOfFirst(initializer);
            }
        }
    }

    if (!Node.isExpression(first)) {
        return undefined;
    }

    const type = first.getType();
    const literals = (type.isUnion() ? type.getUnionTypes() : [type]).map((member) => member.getLiteralValue());

    return literals.every((literal): literal is string => typeof literal === "string") ? literals : undefined;
};

/** The tables a `ctx.db.<method>("table", …)` write names, or `undefined` when `method` is not a write. */
const databaseWrite = (method: string, first: TsNode | undefined): Write | undefined => {
    if (BY_NAME.has(method)) {
        return { method, tables: tablesOfFirst(first) ?? [UNREADABLE_TABLE] };
    }

    return undefined;
};

/** `write` with the fields its call writes, or `undefined` when the call is not a table write. */
const withFields = (write: Write | undefined, call: CallExpression, bodyIndex: number): Write | undefined =>
    write === undefined ? undefined : { ...write, fields: patchedFieldsOf(call, write.method, bodyIndex) };

/**
 * The table an alias names when it is declared as a facade, `const db = ctx.db.posts`. An alias called `db` reads as
 * the generic writer by name, so without this its `db.patch(id, fields)` would take the id for the table. Only a
 * `const` qualifies: a `let` can be reassigned to another table before the write.
 */
const facadeAliasTable = (receiver: TsNode): string | undefined => {
    if (!Node.isIdentifier(receiver)) {
        return undefined;
    }

    const declaration = receiver.getSymbol()?.getDeclarations()[0];

    if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
        return undefined;
    }

    const initializer = declaration.getInitializer();
    const isConst = declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;

    if (!isConst || initializer === undefined || !Node.isPropertyAccessExpression(initializer) || !isDatabaseAccessor(initializer.getExpression())) {
        return undefined;
    }

    return initializer.getName();
};

/** The {@link Write} one call makes, or `undefined` when it is not a table write. */
const writeOf = (call: CallExpression): Write | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();
    const aliasedTable = facadeAliasTable(receiver);

    if (aliasedTable !== undefined) {
        return FACADE_WRITES.has(method) ? withFields({ method, tables: [aliasedTable] }, call, 1) : undefined;
    }

    if (isDatabaseAccessor(receiver)) {
        return withFields(databaseWrite(method, call.getArguments()[0]), call, 2);
    }

    // `ctx.db.<table>.<method>(…)` — the facade puts the table in the receiver.
    if (FACADE_WRITES.has(method) && Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) {
        return withFields({ method, tables: [receiver.getName()] }, call, 1);
    }

    return undefined;
};

/**
 * Discover every table write besides a plain `ctx.db.insert("table", …)` (that is
 * `discoverInserts`): by-id writes (`patch`/`replace`/`delete`/…), batch writes,
 * and the `ctx.db.<table>.*` facade, each with its `CallSiteScope`. A
 * `ctx.db.<method>(table, …)` write takes its table from the first argument when
 * that argument is a string literal or a constant of literal type; anything else
 * is recorded with `table: ""`.
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
            return { ...(write.fields === undefined ? {} : { fields: write.fields }), file, line, method: write.method, scope, table };
        });
    });

export default discoverTableWrites;
