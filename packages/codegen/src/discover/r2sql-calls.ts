import type { Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { handlerOf } from "./discover-ast";
import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { R2sqlCallIR } from "./ir";

/** One resolved query/mutation handler with its attribution. */
interface ResolvedProcedure {
    exportName: string;
    handler: TsNode;
    kind: "mutation" | "query";
}

/**
 * The query/mutation handler of an exported variable declaration, with its
 * attribution (export name + procedure kind), or `undefined` when the
 * declaration isn't an exported `query(...)`/`mutation(...)` with a statically
 * recognisable handler. `action(...)`/`stream(...)` return `undefined` — actions
 * are the intended home for `ctx.r2sql`.
 */
const exportedProcedureHandler = (declaration: VariableDeclaration): ResolvedProcedure | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    if (!classified || (classified.kind !== "query" && classified.kind !== "mutation")) {
        return undefined;
    }

    const handler = handlerOf(initializer, classified.receiver);

    return handler ? { exportName: declaration.getName(), handler, kind: classified.kind } : undefined;
};

/**
 * The `ctx.r2sql` callee label for a `ctx.r2sql` property access, or `undefined`
 * when the access is not `ctx.r2sql`. A direct method call (`ctx.r2sql.from(...)`)
 * yields `ctx.r2sql` suffixed with the method name (e.g. `ctx.r2sql.from`); a
 * bare `ctx.r2sql` (passed/aliased) yields `ctx.r2sql`.
 */
const r2sqlCalleeOf = (access: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(access) || access.getName() !== "r2sql") {
        return undefined;
    }

    const receiver = access.getExpression();

    if (!Node.isIdentifier(receiver) || receiver.getText() !== "ctx") {
        return undefined;
    }

    const parent = access.getParent();

    // `ctx.r2sql.<method>` — the `ctx.r2sql` node is the receiver of an outer
    // member access; label it with the method name.
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === access) {
        return `ctx.r2sql.${parent.getName()}`;
    }

    return "ctx.r2sql";
};

/** `ctx.r2sql` access IRs lexically inside one resolved query/mutation handler. */
const accessesInHandler = (procedure: ResolvedProcedure, file: string): R2sqlCallIR[] => {
    const found: R2sqlCallIR[] = [];

    for (const access of procedure.handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const callee = r2sqlCalleeOf(access);

        if (callee !== undefined) {
            found.push({ callee, exportName: procedure.exportName, file, kind: procedure.kind, line: access.getStartLineNumber() });
        }
    }

    return found;
};

/** `ctx.r2sql` access IRs across every exported query/mutation in one file. */
const accessesInSourceFile = (sourceFile: SourceFile, relativePath: string): R2sqlCallIR[] => {
    const found: R2sqlCallIR[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const procedure = exportedProcedureHandler(declaration);

            if (procedure) {
                found.push(...accessesInHandler(procedure, relativePath));
            }
        }
    }

    return found;
};

/**
 * Discover `ctx.r2sql` accesses lexically inside the handler body of every
 * exported `query(...)` / `mutation(...)` registration under the lunora source
 * directory — the `r2sql_outside_action` lint input. `action(...)` (and
 * `stream(...)`) registrations are intentionally skipped: R2 SQL is the
 * external, non-reactive surface that belongs in actions.
 *
 * Traversal is scoped to the handler node (not the whole declaration), mirroring
 * `discoverNondeterministicCalls` — so a `ctx.r2sql` touch in a sibling helper
 * outside the handler is not attributed to the query/mutation. One
 * {@link R2sqlCallIR} is produced per access site.
 */
const discoverR2sqlCalls = (project: Project, lunoraDirectory: string): R2sqlCallIR[] => {
    const calls: R2sqlCallIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...accessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return calls;
};

export default discoverR2sqlCalls;
