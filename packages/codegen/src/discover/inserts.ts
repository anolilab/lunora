import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { InsertWriteIR } from "../ir";
import { collectCallRows, isDatabaseAccessor } from "./ast";
import { callSiteScopeOf } from "./attribution";

/**
 * True for a `ctx.db.insert(...)` (or bare `db.insert(...)`) call — the database
 * write entry point. The receiver must be `.db` so unrelated `.insert(...)` calls
 * don't match.
 */
const isDatabaseInsertCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "insert") {
        return false;
    }

    const receiver = callee.getExpression();

    return isDatabaseAccessor(receiver);
};

/**
 * Resolve a string-const identifier to its literal value — `const T = "table"`
 * referenced as `insert(T, …)`, including one imported from a sibling lunora
 * file (the presence/ratelimit plugins reference their prefixed table name via
 * such a const). Follows the symbol's (aliased) declaration to a string-literal
 * initializer; returns `undefined` for anything non-constant.
 */
const resolveStringConst = (identifier: TsNode): string | undefined => {
    if (!Node.isIdentifier(identifier)) {
        return undefined;
    }

    const symbol = identifier.getSymbol();
    const declarations = symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? [];

    for (const declaration of declarations) {
        if (Node.isVariableDeclaration(declaration)) {
            const initializer = declaration.getInitializer();

            if (initializer && Node.isStringLiteral(initializer)) {
                return initializer.getLiteralText();
            }
        }
    }

    return undefined;
};

/** The table name from an insert call — a string literal or a resolvable string const — or `""` when it can't be resolved to a literal. */
const tableOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    if (!argument) {
        return "";
    }

    if (Node.isStringLiteral(argument)) {
        return argument.getLiteralText();
    }

    return resolveStringConst(argument) ?? "";
};

/**
 * Discover `ctx.db.insert("table", …)` writes under the lunora source directory,
 * one record per call site with its `CallSiteScope` — so an insert inside a
 * same-file helper carries the exports calling the helper, and one in a helper
 * no export calls is kept rather than lost. A non-literal table argument is kept
 * with `table: ""`.
 */
const discoverInserts = (project: Project, lunoraDirectory: string): InsertWriteIR[] =>
    collectCallRows(project, lunoraDirectory, (call, file): InsertWriteIR | undefined =>
        isDatabaseInsertCall(call) ? { file, line: call.getStartLineNumber(), scope: callSiteScopeOf(call), table: tableOf(call) } : undefined,
    );

export default discoverInserts;
