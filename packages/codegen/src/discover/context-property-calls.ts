import type { Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import type { ContextPropertyCallIR } from "../ir";
import { handlerOf, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { exportedVariableDeclarationsOf, primaryExportName } from "./attribution";
import { contextSurfaceNodesIn } from "./context-root";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

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
 * are the intended home for these action-only surfaces.
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

    return handler ? { exportName: primaryExportName(declaration), handler, kind: classified.kind } : undefined;
};

/**
 * The callee label for a `ctx.<property>` access, or `undefined` when the access
 * is not `ctx.<property>`. A direct method call (`ctx.sql.query(...)`) yields
 * `ctx.sql` suffixed with the method name; a bare `ctx.sql` (called, passed or
 * aliased) yields `ctx.sql`.
 */
const calleeOf = (access: TsNode, property: string): string => {
    const parent = access.getParent();

    // `ctx.<property>.<method>` — the `ctx.<property>` node is the receiver of an
    // outer member access; label it with the method name.
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === access) {
        return `ctx.${property}.${parent.getName()}`;
    }

    return `ctx.${property}`;
};

/** `ctx.<property>` access records lexically inside one resolved query/mutation handler. */
const accessesInHandler = (procedure: ResolvedProcedure, file: string, property: string): ContextPropertyCallIR[] => {
    const found: ContextPropertyCallIR[] = [];

    // Renamed (`c.sql`) and destructured (`const { sql } = ctx`) surfaces resolve by symbol.
    for (const access of contextSurfaceNodesIn(procedure.handler, property)) {
        found.push({ callee: calleeOf(access, property), exportName: procedure.exportName, file, kind: procedure.kind, line: access.getStartLineNumber() });
    }

    return found;
};

/** `ctx.<property>` access records across every exported query/mutation in one file. */
const accessesInSourceFile = (sourceFile: SourceFile, relativePath: string, property: string): ContextPropertyCallIR[] => {
    const found: ContextPropertyCallIR[] = [];

    for (const declaration of exportedVariableDeclarationsOf(sourceFile)) {
        const procedure = exportedProcedureHandler(declaration);

        if (procedure) {
            found.push(...accessesInHandler(procedure, relativePath, property));
        }
    }

    return found;
};

/**
 * Discover `ctx.<property>` accesses lexically inside the handler body of every
 * exported `query(...)` / `mutation(...)` registration under the lunora source
 * directory — the feeder shape behind the "action-only surface used outside an
 * action" lints. `action(...)` (and `stream(...)`) registrations are
 * intentionally skipped: those surfaces are typed on `ActionCtx` only, so an
 * action is where they belong.
 *
 * Traversal is scoped to the handler node (not the whole declaration), mirroring
 * `discoverNondeterministicCalls` — so a touch in a sibling helper outside the
 * handler is not attributed to the query/mutation. One record per access site.
 */
const discoverContextPropertyCalls = (project: Project, lunoraDirectory: string, property: string): ContextPropertyCallIR[] => {
    const calls: ContextPropertyCallIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...accessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath), property));
    }

    return calls;
};

export default discoverContextPropertyCalls;
