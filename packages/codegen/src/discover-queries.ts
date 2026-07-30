import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { QueryReadIR } from "./ir";

/** Chain methods that narrow a read so it is not a full scan. */
const INDEX_METHODS = new Set(["withIndex", "withSearchIndex"]);

/**
 * True for a `ctx.db.query(...)` (or bare `db.query(...)`) call — the database
 * read entry point. The receiver must be `.db` so unrelated `.query(...)` calls
 * and the `ctx.db.system.query(...)` system reader (receiver `system`) don't match.
 */
const isDatabaseQueryCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "query") {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/**
 * Walk the fluent chain rooted at a `query(...)` call and collect the method
 * names invoked on it. A `query(...)` call can only ever be the *expression* of
 * the enclosing `PropertyAccessExpression` (never its name), so reaching a
 * property-access parent followed by a call parent unambiguously continues the
 * chain — `query("t").withIndex(...).filter(...)` yields `["withIndex", "filter"]`.
 */
const chainMethods = (queryCall: CallExpression): string[] => {
    const methods: string[] = [];
    let node: TsNode = queryCall;

    for (;;) {
        const parent = node.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        methods.push(parent.getName());
        node = callParent;
    }

    return methods;
};

/** The literal table name from a `query("table")` call, or `""` when the argument is not a string literal. */
const tableOf = (queryCall: CallExpression): string => {
    const argument = queryCall.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover `ctx.db.query("table")…` reads under the lunora source directory and
 * reduce each to a {@link QueryReadIR}. Only reads that call `.filter()` are
 * returned — an unfiltered read is never a `filter_without_index` candidate, so
 * dropping the rest keeps the lint input small.
 */
const discoverQueries = (project: Project, lunoraDirectory: string): QueryReadIR[] => {
    const reads: QueryReadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isDatabaseQueryCall(call)) {
                continue;
            }

            const methods = chainMethods(call);

            if (!methods.includes("filter")) {
                continue;
            }

            reads.push({
                exportName: enclosingExportName(call),
                file: relativePath,
                hasFilter: true,
                hasIndex: methods.some((method) => INDEX_METHODS.has(method)),
                line: call.getStartLineNumber(),
                table: tableOf(call),
            });
        }
    }

    return reads;
};

export default discoverQueries;
