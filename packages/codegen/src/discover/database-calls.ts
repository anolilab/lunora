/**
 * `ctx.db` call shapes the feeders read: which receiver is the database, the
 * table and options a read addresses, and the tables a procedure touches. The
 * receiver goes through the shared ctx resolver (`context-root`), so a renamed
 * or destructured ctx reaches the same calls.
 */
import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { denotesContextDatabase } from "./context-root";

/**
 * True when `receiver` is the database accessor: anything named `db` by
 * shape (`ctx.db`, `this.db`, a bare `db`, as every feeder has always matched
 * it), or a binding resolving to `ctx.db` under another name
 * (`const database = ctx.db`).
 */
const isDatabaseAccessor = (receiver: TsNode): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") ||
    (Node.isIdentifier(receiver) && receiver.getText() === "db") ||
    denotesContextDatabase(receiver);

/**
 * List reads whose options object the `ctx.db` read feeders inspect. Only
 * `findMany` / `findFirst` / `findFirstOrThrow` / `findUnique` take an options
 * object — the by-id `get` is id-only and the fluent `query(...)` reader carries
 * no options object, so both are excluded.
 *
 * A read method missing from this set is INVISIBLE to every feeder that reads
 * through `readTargetOf` — the soft-delete and relation-load analyses — so adding
 * one to the facade means adding it here in the same change.
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "findUnique"]);

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
    if (isDatabaseAccessor(receiver)) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the table reader sits with the other per-call helpers below
        return { options: call.getArguments()[1], table: tableArgumentOf(call) };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = isDatabaseAccessor(inner);

        if (onDatabase) {
            return { options: call.getArguments()[0], table: receiver.getName() };
        }
    }

    return undefined;
};

/** True when `call` is a `ctx.db.<method>(...)` or bare `db.<method>(...)` call against `methodSet`. */
const isDatabaseCall = (call: CallExpression, methodSet: ReadonlySet<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    return isDatabaseAccessor(callee.getExpression());
};

/** String-literal first argument of a `ctx.db.<method>("table", ...)` call, or `""` when the argument is not a string literal (dynamic table — not lintable). */
const tableArgumentOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover the set of tables read and written inside the lexical scope of the
 * exported procedure binding (including helper closures in the body), against
 * the caller's read/write method sets.
 */
const tablesAccessedIn = (
    declaration: TsNode,
    readMethods: ReadonlySet<string>,
    writeMethods: ReadonlySet<string>,
): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDatabaseCall(call, readMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDatabaseCall(call, writeMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

export { isDatabaseAccessor, readTargetOf, tablesAccessedIn };
