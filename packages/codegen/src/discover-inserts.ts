import type { CallExpression, Project } from "ts-morph";
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

/** The literal table name from an `insert("table", …)` call, or `""` when the argument is not a string literal. */
const tableOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
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
