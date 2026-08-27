import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./discover-ast";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { InsertWriteIR } from "./ir";

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

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
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
 * Discover `ctx.db.insert("table", …)` writes under the lunora source directory
 * and attribute each to the exported function (and file) performing it. Calls
 * with a non-literal table argument, or outside an exported declaration, are
 * dropped (`table === ""` / no enclosing export).
 */
const discoverInserts = (project: Project, lunoraDirectory: string): InsertWriteIR[] => {
    const writes: InsertWriteIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isDatabaseInsertCall(call)) {
                continue;
            }

            const exportName = enclosingExportName(call);

            if (exportName === "") {
                continue;
            }

            writes.push({ exportName, file: relativePath, line: call.getStartLineNumber(), table: tableOf(call) });
        }
    }

    return writes;
};

export default discoverInserts;
