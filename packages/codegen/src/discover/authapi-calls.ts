import type { CallExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, lunoraRelativePath } from "./discover-ast";
import { listLunoraSourceFiles } from "./discover-functions";
import type { AuthApiCallIR } from "./ir";

/**
 * True for a `ctx.authApi.<method>(...)` (or bare `authApi.<method>(...)`)
 * call — the privileged better-auth API surface installed by `withAuthPlugins`.
 *
 * Accepted receiver shapes: (1) a `PropertyAccessExpression` whose receiver is
 * itself a `PropertyAccessExpression` named `authApi` — the standard
 * `ctx.authApi.<method>` form; (2) a bare `authApi` identifier — the
 * destructured `const { authApi } = ctx` case. We require the inner receiver
 * to be named `authApi` rather than requiring the outermost receiver to be
 * `ctx`, per the plan STOP note: under-report rather than flag unrelated code.
 */
const isAuthApiCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return false;
    }

    const receiver = callee.getExpression();

    // Shape 1: <something>.authApi.<method>(...)
    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "authApi";
    }

    // Shape 2: authApi.<method>(...) — destructured `const { authApi } = ctx`
    return Node.isIdentifier(receiver) && receiver.getText() === "authApi";
};

/**
 * Determine whether the first argument to a `ctx.authApi.*` call includes a
 * `headers` property.
 *
 * Conservative rule (per plan STOP note on spreads): when the argument is an
 * object literal, we check for a literal `headers` property assignment or
 * shorthand. A spread element (`{ ...base }`) is treated as `hasHeaders: true`
 * — we cannot statically prove it is absent. When the argument is not an object
 * literal at all (a variable, a call, etc.), we return `true` to avoid false
 * positives: we cannot prove headers is missing, and alarm fatigue on a
 * security lint is worse than an under-report.
 */
const hasHeadersProp = (call: CallExpression): boolean => {
    const argument = call.getArguments()[0];

    if (argument === undefined) {
        // No argument at all — no headers.
        return false;
    }

    if (!Node.isObjectLiteralExpression(argument)) {
        // Can't prove headers is absent → don't flag.
        return true;
    }

    for (const property of argument.getProperties()) {
        if ((Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && property.getName() === "headers") {
            return true;
        }

        // A spread element like `{ ...base }` — we can't prove headers is absent.
        if (Node.isSpreadAssignment(property)) {
            return true;
        }
    }

    return false;
};

/**
 * Discover `ctx.authApi.<method>(...)` (and bare `authApi.<method>(...)`) calls
 * under the lunora source directory and attribute each to the exported function
 * (and file) performing it. Calls outside an exported declaration are dropped.
 */
const discoverAuthApiCalls = (project: Project, lunoraDirectory: string): AuthApiCallIR[] => {
    const calls: AuthApiCallIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isAuthApiCall(call)) {
                continue;
            }

            const exportName = enclosingExportName(call);

            if (exportName === "") {
                continue;
            }

            const callee = call.getExpression();
            const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : "";

            calls.push({
                exportName,
                file: relativePath,
                hasHeaders: hasHeadersProp(call),
                line: call.getStartLineNumber(),
                method,
            });
        }
    }

    return calls;
};

export default discoverAuthApiCalls;
