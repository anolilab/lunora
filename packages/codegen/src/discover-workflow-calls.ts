import type { CallExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { cirrusRelativePath, listCirrusSourceFiles } from "./discover-functions";
import type { WorkflowCallIR } from "./ir";

/**
 * True for a `ctx.workflows.get(...)` (or bare `workflows.get(...)`) call — the
 * workflow start/lookup entry point. The receiver must be `.workflows` so
 * unrelated `.get(...)` calls (maps, headers, query params) don't match. Mirrors
 * `isDatabaseInsertCall`'s receiver guard.
 */
const isWorkflowGetCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get") {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "workflows";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "workflows";
};

/** The literal workflow name from a `get("name")` call, or `""` when the argument is not a string literal. */
const workflowOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Export binding name of the exported, top-level function that lexically contains
 * the call (e.g. `export const create = mutation({ … })` → `"create"`), or `""`
 * when the call isn't inside an exported declaration. Walks out past any local
 * `const handle = ctx.workflows.get(...)` to the exported one.
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
 * Discover `ctx.workflows.get("name")` call sites under the cirrus source
 * directory and attribute each to the exported function (and file) performing
 * it. A call outside an exported declaration is dropped; a call with a
 * non-literal name argument is kept with `workflow === ""` so the unused-workflow
 * lint can treat it as a dynamic use (and suppress its heuristic) rather than
 * silently ignoring it.
 */
const discoverWorkflowCalls = (project: Project, cirrusDirectory: string): WorkflowCallIR[] => {
    const calls: WorkflowCallIR[] = [];

    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = cirrusRelativePath(cirrusDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isWorkflowGetCall(call)) {
                continue;
            }

            const exportName = enclosingExportName(call);

            if (exportName === "") {
                continue;
            }

            calls.push({ exportName, file: relativePath, line: call.getStartLineNumber(), workflow: workflowOf(call) });
        }
    }

    return calls;
};

export default discoverWorkflowCalls;
