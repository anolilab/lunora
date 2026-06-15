import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { cirrusRelativePath, classifyProcedureCall, listCirrusSourceFiles } from "./discover-functions";
import type { NondeterministicCallIR } from "./ir";

/**
 * The non-deterministic global APIs disallowed inside `query`/`mutation`
 * handlers, keyed by the receiver-qualified label the lint surfaces. Property
 * accesses (`Date.now`, `Math.random`, `crypto.randomUUID`,
 * `crypto.getRandomValues`) match when the `receiver.method` pair is in this set;
 * bare/`globalThis`/`self` `fetch` is handled separately below.
 */
const PROPERTY_CALLS: Record<string, string> = {
    "crypto.getRandomValues": "crypto.getRandomValues",
    "crypto.randomUUID": "crypto.randomUUID",
    "Date.now": "Date.now",
    "Math.random": "Math.random",
};

/** Global receiver names whose `.fetch(...)` is the same global `fetch`. */
const FETCH_GLOBAL_RECEIVERS = new Set(["globalThis", "self"]);

/**
 * The non-deterministic callee label for `call`, or `undefined` when the call is
 * not one of the disallowed APIs. Recognises:
 *
 * - `Date.now()` / `Math.random()` / `crypto.randomUUID()` /
 * `crypto.getRandomValues(...)` — a `PropertyAccessExpression` whose
 * `receiver.method` pair is in {@link PROPERTY_CALLS};
 * - bare `fetch(...)` — an identifier callee named `fetch`;
 * - `globalThis.fetch(...)` / `self.fetch(...)` — a property access of `fetch`
 * on a global receiver.
 *
 * Receivers are matched by surface text (no import resolution): these are
 * ambient globals, never imported, so there is no binding to follow.
 */
const nondeterministicCalleeOf = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    // Bare `fetch(...)`.
    if (Node.isIdentifier(callee)) {
        return callee.getText() === "fetch" ? "fetch" : undefined;
    }

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();

    if (!Node.isIdentifier(receiver)) {
        return undefined;
    }

    const receiverName = receiver.getText();

    // `globalThis.fetch(...)` / `self.fetch(...)` — the same global `fetch`.
    if (method === "fetch" && FETCH_GLOBAL_RECEIVERS.has(receiverName)) {
        return "fetch";
    }

    return PROPERTY_CALLS[`${receiverName}.${method}`];
};

/**
 * The handler node of a `query`/`mutation` registration, scoped so traversal
 * only inspects code that actually runs as the procedure body:
 *
 * - bare factory (`query({ args, handler })`) → the `handler:` initializer;
 * - builder terminal (`c.use(...).query(handler)`) → the terminal's first argument.
 *
 * Returns `undefined` when the handler isn't a statically-recognisable
 * function expression (so we under-report rather than scan an unrelated node).
 */
const handlerOf = (call: CallExpression, receiver: TsNode | undefined): TsNode | undefined => {
    // Builder terminal: the handler is the terminal call's first argument.
    if (receiver) {
        const handler = call.getArguments()[0];

        return handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) ? handler : undefined;
    }

    // Bare factory: pull the `handler:` property off the first object-literal argument.
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return undefined;
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return undefined;
    }

    const initializer = handlerProperty.getInitializer();

    return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) ? initializer : undefined;
};

/** One resolved procedure handler with its attribution. */
interface ResolvedProcedure {
    exportName: string;
    handler: TsNode;
    kind: "mutation" | "query";
}

/**
 * The query/mutation handler of an exported variable declaration, with its
 * attribution (export name + procedure kind), or `undefined` when the
 * declaration isn't an exported `query(...)`/`mutation(...)` with a statically
 * recognisable handler. `action(...)`/`stream(...)` and non-procedure
 * initializers return `undefined` — actions run once and may use ambient APIs.
 */
const exportedProcedureHandler = (declaration: VariableDeclaration): ResolvedProcedure | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    // Shared classification (kind + builder receiver) — single source of truth
    // with function discovery and the RLS feeder.
    const classified = classifyProcedureCall(initializer);

    if (!classified || (classified.kind !== "query" && classified.kind !== "mutation")) {
        return undefined;
    }

    const handler = handlerOf(initializer, classified.receiver);

    return handler ? { exportName: declaration.getName(), handler, kind: classified.kind } : undefined;
};

/** Non-deterministic call IRs lexically inside one resolved procedure handler. */
const callsInHandler = (procedure: ResolvedProcedure, file: string): NondeterministicCallIR[] => {
    const found: NondeterministicCallIR[] = [];

    for (const callNode of procedure.handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = nondeterministicCalleeOf(callNode);

        if (callee !== undefined) {
            found.push({ callee, exportName: procedure.exportName, file, kind: procedure.kind, line: callNode.getStartLineNumber() });
        }
    }

    return found;
};

/** Non-deterministic call IRs across every exported query/mutation in one file. */
const callsInSourceFile = (sourceFile: SourceFile, relativePath: string): NondeterministicCallIR[] => {
    const found: NondeterministicCallIR[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const procedure = exportedProcedureHandler(declaration);

            if (procedure) {
                found.push(...callsInHandler(procedure, relativePath));
            }
        }
    }

    return found;
};

/**
 * Discover non-deterministic API calls (`Date.now`, `Math.random`,
 * `crypto.randomUUID`, `crypto.getRandomValues`, `fetch`) lexically inside the
 * handler body of every exported `query(...)` / `mutation(...)` registration
 * under the cirrus source directory — the `nondeterministic_query_mutation` lint
 * input. `action(...)` (and `stream(...)`) registrations are intentionally
 * skipped: actions run exactly once and may use ambient APIs freely.
 *
 * Traversal is scoped to the handler node (not the whole declaration), mirroring
 * how the auth-api / insert feeders attribute calls — so a call in a sibling
 * helper outside the handler, or in a nested `action(...)` passed elsewhere, is
 * not attributed to the query/mutation. One {@link NondeterministicCallIR} is
 * produced per call site.
 */
const discoverNondeterministicCalls = (project: Project, cirrusDirectory: string): NondeterministicCallIR[] => {
    const calls: NondeterministicCallIR[] = [];

    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...callsInSourceFile(sourceFile, cirrusRelativePath(cirrusDirectory, filePath)));
    }

    return calls;
};

export default discoverNondeterministicCalls;
