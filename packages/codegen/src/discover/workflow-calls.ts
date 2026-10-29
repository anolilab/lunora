import type { CallExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { WorkflowCallIR } from "../ir";
import { collectCallRows } from "./ast";
import { callSiteScopeOf } from "./attribution";

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
 * Discover `ctx.workflows.get("name")` call sites under the lunora source
 * directory, one record per site with its `CallSiteScope`. A call with a
 * non-literal name argument is kept with `workflow === ""` so the unused-workflow
 * lint can treat it as a dynamic use (and suppress its heuristic) rather than
 * silently ignoring it.
 */
const discoverWorkflowCalls = (project: Project, lunoraDirectory: string): WorkflowCallIR[] =>
    collectCallRows(project, lunoraDirectory, (call, file): WorkflowCallIR | undefined =>
        isWorkflowGetCall(call) ? { file, line: call.getStartLineNumber(), scope: callSiteScopeOf(call), workflow: workflowOf(call) } : undefined,
    );

export default discoverWorkflowCalls;
