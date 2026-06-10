import { relative, sep } from "node:path";

import type { CallExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions";
import type { InsertWriteIR } from "./ir";

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE = /\.ts$/u;

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
 * Export binding name of the exported, top-level function that lexically contains
 * the call (e.g. `export const send = mutation({ … })` → `"send"`), or `""` when
 * the call isn't inside an exported declaration. Skips local `const x = db.insert`
 * declarations and walks out to the exported one.
 */
const enclosingExportName = (call: CallExpression): string => {
    for (const ancestor of call.getAncestors()) {
        if (Node.isVariableDeclaration(ancestor) && ancestor.getVariableStatement()?.hasExportKeyword() === true) {
            return ancestor.getName();
        }
    }

    return "";
};

/**
 * Discover `ctx.db.insert("table", …)` writes under the cirrus source directory
 * and attribute each to the exported function (and file) performing it. Calls
 * with a non-literal table argument, or outside an exported declaration, are
 * dropped (`table === ""` / no enclosing export).
 */
const discoverInserts = (project: Project, cirrusDirectory: string): InsertWriteIR[] => {
    const writes: InsertWriteIR[] = [];

    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = relative(cirrusDirectory, filePath).replace(TS_EXTENSION_RE, "").split(sep).join("/");

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
