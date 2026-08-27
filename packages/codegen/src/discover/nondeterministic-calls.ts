import type { CallExpression, NewExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { handlerOf } from "./discover-ast";
import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
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

/** Global wrapper receivers (`globalThis` / `self` / `window`) whose member is the same ambient global. */
const GLOBAL_THIS_RECEIVERS = new Set(["globalThis", "self", "window"]);

/**
 * The rightmost receiver name to match against {@link PROPERTY_CALLS}. A bare
 * identifier (`crypto`, `Date`, `Math`) yields its text; a property access yields
 * its member name *peeled past* a `globalThis`/`self`/`window` wrapper, so
 * `globalThis.crypto.randomUUID()` and `self.crypto.getRandomValues()` resolve to
 * the same `crypto` receiver as the single-identifier form. Returns `undefined`
 * for any other shape (e.g. an indexed/computed receiver).
 */
const receiverNameOf = (receiver: TsNode): string | undefined => {
    if (Node.isIdentifier(receiver)) {
        return receiver.getText();
    }

    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();

        // `globalThis.crypto` / `self.crypto` / `window.crypto` → `crypto`.
        if (Node.isIdentifier(inner) && GLOBAL_THIS_RECEIVERS.has(inner.getText())) {
            return receiver.getName();
        }
    }

    return undefined;
};

/**
 * The non-deterministic callee label for `call`, or `undefined` when the call is
 * not one of the disallowed APIs. Recognises:
 *
 * - `Date.now()` / `Math.random()` / `crypto.randomUUID()` /
 * `crypto.getRandomValues(...)` — a `PropertyAccessExpression` whose
 * `receiver.method` pair is in {@link PROPERTY_CALLS}, including a
 * `globalThis`/`self`/`window`-prefixed receiver (`globalThis.crypto.randomUUID()`);
 * - bare `Date()` / `fetch(...)` — an identifier callee;
 * - `globalThis.fetch(...)` / `self.fetch(...)` / `window.fetch(...)` — a property
 * access of `fetch` on a global receiver.
 *
 * Receivers are matched by surface text (no import resolution): these are
 * ambient globals, never imported, so there is no binding to follow.
 */
const nondeterministicCalleeOf = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    // Bare `fetch(...)` / `Date(...)`.
    if (Node.isIdentifier(callee)) {
        const name = callee.getText();

        return name === "fetch" || name === "Date" ? name : undefined;
    }

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const receiverName = receiverNameOf(callee.getExpression());

    if (receiverName === undefined) {
        return undefined;
    }

    // `globalThis.fetch(...)` / `self.fetch(...)` / `window.fetch(...)` — global `fetch`.
    if (method === "fetch" && FETCH_GLOBAL_RECEIVERS.has(receiverName)) {
        return "fetch";
    }

    return PROPERTY_CALLS[`${receiverName}.${method}`];
};

/**
 * The non-deterministic label for a `new …()` expression, or `undefined`. Only
 * `new Date()` (no argument, or a non-literal argument that isn't a fixed epoch)
 * reads the wall clock; `new Date(2020, 0, 1)` / `new Date("…")` with literal
 * arguments is deterministic, so it is not flagged. `new Date()` is as
 * non-deterministic as `Date.now()`, which the call path already flags.
 */
const nondeterministicNewOf = (expression: NewExpression): string | undefined => {
    const callee = expression.getExpression();

    if (!Node.isIdentifier(callee) || callee.getText() !== "Date") {
        return undefined;
    }

    const argumentNodes = expression.getArguments();

    // `new Date(<literal…>)` pins a fixed instant — deterministic. A zero-arg or
    // dynamically-argumented `new Date()` reads the clock.
    const allLiteral = argumentNodes.every(
        (argument) => Node.isNumericLiteral(argument) || Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument),
    );

    return argumentNodes.length > 0 && allLiteral ? undefined : "new Date";
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

    // `new Date()` is a NewExpression, not a CallExpression — traverse it too so
    // wall-clock reads via the constructor are caught alongside `Date.now()`.
    for (const newNode of procedure.handler.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const callee = nondeterministicNewOf(newNode);

        if (callee !== undefined) {
            found.push({ callee, exportName: procedure.exportName, file, kind: procedure.kind, line: newNode.getStartLineNumber() });
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
 * Discover non-deterministic API calls (`Date.now`, `new Date()`, `Date()`,
 * `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues` — including
 * `globalThis`/`self`/`window`-prefixed receivers — and `fetch`) lexically inside
 * the handler body of every exported `query(...)` / `mutation(...)` registration
 * under the lunora source directory — the `nondeterministic_query_mutation` lint
 * input. `action(...)` (and `stream(...)`) registrations are intentionally
 * skipped: actions run exactly once and may use ambient APIs freely.
 *
 * Traversal is scoped to the handler node (not the whole declaration), mirroring
 * how the auth-api / insert feeders attribute calls — so a call in a sibling
 * helper outside the handler, or in a nested `action(...)` passed elsewhere, is
 * not attributed to the query/mutation. One {@link NondeterministicCallIR} is
 * produced per call site.
 */
const discoverNondeterministicCalls = (project: Project, lunoraDirectory: string): NondeterministicCallIR[] => {
    const calls: NondeterministicCallIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...callsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return calls;
};

export default discoverNondeterministicCalls;
