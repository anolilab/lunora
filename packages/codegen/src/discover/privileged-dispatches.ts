import type { ArrowFunction, CallExpression, FunctionExpression, Identifier, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { PrivilegedDispatchIR } from "./ir";

/**
 * The privileged-dispatch handler factories. A `defineQueue` push handler and a
 * `defineWorkflow` handler both run under the **system identity** (RLS
 * disabled) — a `ctx.run`/`context.run` back into a Lunora function from inside
 * one skips every end-user row policy. Matched by callee *name* (the
 * `import`-agnostic, fail-closed convention the other feeders use).
 */
const HANDLER_FACTORIES = new Set(["defineQueue", "defineWorkflow"]);

/** The dispatch methods on the handler's context param that call back into a Lunora function. */
const DISPATCH_METHODS = new Set(["run", "runAction", "runMutation", "runQuery"]);

/** The `FunctionReference` root namespaces codegen emits (`api.<file>.<export>` / `internal.<file>.<export>`). */
const REFERENCE_ROOTS = new Set(["api", "internal"]);

type HandlerFunction = ArrowFunction | FunctionExpression;

/** The simple callee name of a call expression, or `undefined`. */
const calleeName = (call: CallExpression): string | undefined => {
    const expression = call.getExpression();

    return Node.isIdentifier(expression) ? expression.getText() : undefined;
};

/** The `handler` property's arrow/function expression on a `defineQueue`/`defineWorkflow` config literal, or `undefined`. */
const handlerFunctionOf = (call: CallExpression): HandlerFunction | undefined => {
    const config = call.getArguments()[0];

    if (!config || !Node.isObjectLiteralExpression(config)) {
        return undefined;
    }

    const property = config.getProperty("handler");

    if (property === undefined || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return initializer;
    }

    return undefined;
};

/** The name of a handler parameter at `index`, or `undefined` when absent / not a plain identifier binding. */
const parameterName = (handler: HandlerFunction, index: number): string | undefined => {
    const nameNode = handler.getParameters()[index]?.getNameNode();

    return nameNode && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
};

/**
 * True when `text` is exactly `prefix` or a property path under it (`prefix.…`),
 * respecting the dot boundary so `context.params` never matches `context.paramsX`.
 */
const isUnderPath = (text: string, prefix: string): boolean => text === prefix || text.startsWith(`${prefix}.`);

/**
 * Every property-access expression at or below `node` — `getDescendantsOfKind`
 * excludes the node itself, so a payload expression that *is* the whole subtree
 * (`const { x } = context.params` — initializer is exactly `context.params`)
 * would otherwise be missed.
 */
const propertyAccessesIn = (node: TsNode): TsNode[] => {
    const accesses: TsNode[] = node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);

    if (Node.isPropertyAccessExpression(node)) {
        accesses.push(node);
    }

    return accesses;
};

/**
 * True when `identifier` sits in a *value-reference* position — not an
 * object-literal key (`{ channelId: safe() }`), a member name (`x.channelId`), or
 * a destructuring binding name (`const { channelId } = …`). Those name positions
 * merely share a payload binding's spelling without being a use of it, so counting
 * them would flag a safe `{ channelId: computeSafe() }` dispatch as payload-derived.
 * A shorthand `{ channelId }` IS a value reference and is kept.
 */
const isReferenceIdentifier = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isBindingElement(parent) && parent.getNameNode() === identifier);
};

/**
 * Every *value-reference* identifier at or below `node` (including `node` itself
 * when it is one). Name-only positions are excluded — see {@link isReferenceIdentifier}.
 */
const identifiersIn = (node: TsNode): Identifier[] => {
    const identifiers = node.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => isReferenceIdentifier(identifier));

    if (Node.isIdentifier(node) && isReferenceIdentifier(node)) {
        identifiers.push(node);
    }

    return identifiers;
};

/** The identifier names bound (by `const x = …` or `const { a, b } = …`) in `declaration`. */
const declaredNames = (declaration: TsNode): string[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const nameNode = declaration.getNameNode();

    if (Node.isIdentifier(nameNode)) {
        return [nameNode.getText()];
    }

    // `const { a, b } = payload` / `const [a] = payload` — every bound element name.
    return nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getName());
};

/**
 * The payload access-path prefixes for a queue handler — `<batch>.messages`
 * (the batch param at index 1) plus `<message>.body` for each `message`
 * bound by a `for (… of <batch>.messages)` loop. Empty when the handler
 * declares no batch parameter.
 */
const queuePayloadPrefixes = (handler: HandlerFunction): string[] => {
    const batchParameter = parameterName(handler, 1);

    if (batchParameter === undefined) {
        return [];
    }

    const prefixes = [`${batchParameter}.messages`];

    for (const loop of handler.getDescendantsOfKind(SyntaxKind.ForOfStatement)) {
        if (loop.getExpression().getText() !== `${batchParameter}.messages`) {
            continue;
        }

        const declarations = loop.getInitializer();
        const binding = Node.isVariableDeclarationList(declarations) ? declarations.getDeclarations()[0]?.getNameNode() : undefined;

        if (binding && Node.isIdentifier(binding)) {
            prefixes.push(`${binding.getText()}.body`);
        }
    }

    return prefixes;
};

/**
 * Collect the payload access paths and locally-bound payload names for one
 * handler. The *payload* is the untrusted external input a privileged handler
 * receives — `<context>.params` for a workflow (set by the mutation/action
 * that called `.create({ params })`, which may embed `args.*`), or a
 * `<message>.body` for a queue (see {@link queuePayloadPrefixes}).
 *
 * A `const` (or destructuring) whose initializer is already payload-derived
 * contributes its bound name(s), so `const { channelId } = context.params; …
 * channelId` is tracked one hop out.
 */
const collectPayload = (handler: HandlerFunction, kind: "queue" | "workflow", contextParameter: string): { names: Set<string>; prefixes: string[] } => {
    const prefixes = kind === "workflow" ? [`${contextParameter}.params`] : queuePayloadPrefixes(handler);
    const names = new Set<string>();

    // Follow one forward pass of `const`-bindings whose initializer is payload-derived.
    const referencesPayload = (node: TsNode): boolean => {
        if (propertyAccessesIn(node).some((access) => prefixes.some((prefix) => isUnderPath(access.getText(), prefix)))) {
            return true;
        }

        return identifiersIn(node).some((identifier) => names.has(identifier.getText()));
    };

    for (const declaration of handler.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = declaration.getInitializer();

        if (initializer && referencesPayload(initializer)) {
            for (const name of declaredNames(declaration)) {
                names.add(name);
            }
        }
    }

    return { names, prefixes };
};

/** True when `argsNode` (the dispatch's args object) references a payload path or a locally-bound payload name. */
const argumentsReferencePayload = (argsNode: TsNode, payload: { names: Set<string>; prefixes: string[] }): boolean => {
    if (propertyAccessesIn(argsNode).some((access) => payload.prefixes.some((prefix) => isUnderPath(access.getText(), prefix)))) {
        return true;
    }

    return identifiersIn(argsNode).some((identifier) => payload.names.has(identifier.getText()));
};

/**
 * Resolve a `FunctionReference` argument (`api.<file>.<export>` /
 * `internal.<dir>.<file>.<export>`) to its `{ file, exportName }`, or
 * `undefined` when the target is not a static `api`/`internal` member chain
 * (a variable or computed target can't be joined to RLS evidence, so it is
 * skipped fail-closed).
 */
const resolveTarget = (node: TsNode | undefined): { exportName: string; file: string } | undefined => {
    if (node === undefined || !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const segments: string[] = [];
    let current: TsNode = node;

    while (Node.isPropertyAccessExpression(current)) {
        segments.unshift(current.getName());
        current = current.getExpression();
    }

    const exportName = segments.at(-1);

    if (exportName === undefined || !Node.isIdentifier(current) || !REFERENCE_ROOTS.has(current.getText()) || segments.length < 2) {
        return undefined;
    }

    return { exportName, file: segments.slice(0, -1).join("/") };
};

/** Payload-derived privileged dispatches inside one handler. */
const dispatchesInHandler = (handler: HandlerFunction, kind: "queue" | "workflow", relativePath: string): PrivilegedDispatchIR[] => {
    const contextParameter = parameterName(handler, 0);

    if (contextParameter === undefined) {
        return [];
    }

    const payload = collectPayload(handler, kind, contextParameter);
    const found: PrivilegedDispatchIR[] = [];

    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const receiver = call.getExpression();

        if (
            !Node.isPropertyAccessExpression(receiver) ||
            !DISPATCH_METHODS.has(receiver.getName()) ||
            receiver.getExpression().getText() !== contextParameter
        ) {
            continue;
        }

        const argumentsObject = call.getArguments()[1];

        if (!argumentsObject || !argumentsReferencePayload(argumentsObject, payload)) {
            continue;
        }

        const target = resolveTarget(call.getArguments()[0]);

        if (target === undefined) {
            continue;
        }

        found.push({
            dispatchKind: kind,
            file: relativePath,
            handlerExport: enclosingExportName(call),
            line: call.getStartLineNumber(),
            targetExport: target.exportName,
            targetFile: target.file,
        });
    }

    return found;
};

/** Payload-derived privileged dispatches in one source file. */
const dispatchesInSourceFile = (sourceFile: SourceFile, relativePath: string): PrivilegedDispatchIR[] => {
    const found: PrivilegedDispatchIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(call);

        if (name === undefined || !HANDLER_FACTORIES.has(name)) {
            continue;
        }

        const handler = handlerFunctionOf(call);

        if (handler === undefined) {
            continue;
        }

        found.push(...dispatchesInHandler(handler, name === "defineQueue" ? "queue" : "workflow", relativePath));
    }

    return found;
};

/**
 * Discover privileged dispatches in `lunora/` — a `ctx.run`/`context.run` back
 * into a Lunora function from inside a `defineQueue` push handler or a
 * `defineWorkflow` handler, whose args reference the handler's untrusted
 * payload (`context.params` for a workflow, a `for (… of batch.messages)`
 * body for a queue). Both handler kinds run under the **system identity** with
 * end-user RLS disabled, so forwarding attacker-influenced payload into a
 * dispatch is a confused-deputy path *iff* the target enforces a row policy —
 * the `privileged_dispatch_unvalidated_payload` lint makes that call by joining
 * `targetFile`/`targetExport` against the RLS-procedure evidence. Records the
 * resolved target so the lint can filter to RLS-gated targets; a target that
 * isn't a static `api`/`internal` member chain is skipped fail-closed.
 */
const discoverPrivilegedDispatches = (project: Project, lunoraDirectory: string): PrivilegedDispatchIR[] => {
    const rows: PrivilegedDispatchIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...dispatchesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverPrivilegedDispatches;
