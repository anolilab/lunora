import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node, VariableDeclarationKind } from "ts-morph";

import { isDatabaseAccessor } from "./database-calls";

/** `ctx.db.<table>.<method>(…)` facade writes — the table is the receiver's property name. */
export const FACADE_WRITES: ReadonlySet<string> = new Set([
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

/** A `ctx.db.<table>.<method>(…)` facade write, or one through a `const t = ctx.db.<table>` alias. */
export interface FacadeWrite {
    /** The expression that denotes the database (`ctx.db`), for the caller's own trust check. */
    database: TsNode;
    method: string;
    table: string;
}

/**
 * The facade a `const` alias names, `const posts = ctx.db.posts`, with the expression that denotes the database. An
 * alias called `db` reads as the generic writer by name, so without this its `db.patch(id, fields)` would take the id
 * for the table. Only a `const` qualifies: a `let` can be reassigned to another table before the write.
 */
export const facadeAliasOf = (receiver: TsNode): { database: TsNode; table: string } | undefined => {
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

    return { database: initializer.getExpression(), table: initializer.getName() };
};

/**
 * The facade write `call` makes when its method is one of `methods`: either through a const alias of a facade, or
 * directly as `<database>.<table>.<method>(…)`. `undefined` for any other call.
 */
export const facadeWriteOf = (call: CallExpression, methods: ReadonlySet<string>): FacadeWrite | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methods.has(callee.getName())) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();
    const alias = facadeAliasOf(receiver);

    if (alias !== undefined) {
        return { database: alias.database, method, table: alias.table };
    }

    if (Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) {
        return { database: receiver.getExpression(), method, table: receiver.getName() };
    }

    return undefined;
};
