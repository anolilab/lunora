import type { CallExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ContainerOverrideIR } from "./ir";

/** Runtime egress-firewall mutators on a `<handle>.egress` control surface — the `egress_relaxation` sink set. */
const EGRESS_MUTATING_METHODS = new Set(["allow", "deny", "setAllowed"]);

/** True when `call`'s first argument is an object literal with an explicit `enableInternet: true` property. */
const hasEnableInternetTrue = (call: CallExpression): boolean => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return false;
    }

    const property = argument.getProperty("enableInternet");

    return property !== undefined && Node.isPropertyAssignment(property) && Node.isTrueLiteral(property.getInitializerOrThrow());
};

/** The IR row for a `<x>.start({ enableInternet: true, … })` launch override, or `undefined`. */
const enableInternetOverrideInCall = (call: CallExpression, relativePath: string): ContainerOverrideIR | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "start" || !hasEnableInternetTrue(call)) {
        return undefined;
    }

    return {
        detail: "enableInternet: true",
        exportName: enclosingExportName(call),
        file: relativePath,
        kind: "enable_internet",
        line: call.getStartLineNumber(),
    };
};

/** The IR row for a `<x>.egress.<method>(...)` runtime firewall mutation, or `undefined`. */
const egressRelaxationInCall = (call: CallExpression, relativePath: string): ContainerOverrideIR | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !EGRESS_MUTATING_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    if (!Node.isPropertyAccessExpression(receiver) || receiver.getName() !== "egress") {
        return undefined;
    }

    return {
        detail: callee.getName(),
        exportName: enclosingExportName(call),
        file: relativePath,
        kind: "egress_relaxation",
        line: call.getStartLineNumber(),
    };
};

/** The IR row for `call` matching either container-override shape, or `undefined`. */
const containerOverrideInCall = (call: CallExpression, relativePath: string): ContainerOverrideIR | undefined =>
    enableInternetOverrideInCall(call, relativePath) ?? egressRelaxationInCall(call, relativePath);

/** Container-override calls found in one source file. */
const containerOverridesInSourceFile = (sourceFile: SourceFile, relativePath: string): ContainerOverrideIR[] => {
    const found: ContainerOverrideIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const row = containerOverrideInCall(call, relativePath);

        if (row) {
            found.push(row);
        }
    }

    return found;
};

/**
 * Discover every runtime container-override call in `lunora/` source: a
 * `.start({ enableInternet: true, … })` launch override, or a
 * `.egress.<method>(...)` runtime firewall mutation (`allow` / `deny` /
 * `setAllowed`). Matched structurally by call shape — the receiver's type is
 * never resolved, so this also works before `pnpm install` has linked
 * `@lunora/container`.
 */
const discoverContainerOverrides = (project: Project, lunoraDirectory: string): ContainerOverrideIR[] => {
    const rows: ContainerOverrideIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...containerOverridesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverContainerOverrides;
