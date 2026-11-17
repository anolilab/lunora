import type {
    ArrowFunction,
    BindingElement,
    BindingName,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    Node as TsNode,
    Project,
    SourceFile,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { PrivilegedDispatchIR } from "../ir";
import { descendantsOfKind, findObjectProperty, functionReferenceSegments, listLunoraSourceFiles, lunoraRelativePath, RUN_METHODS } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { memberFunctionOf } from "./context-root";

/**
 * The privileged-dispatch handler factories, mapped to the index of their config
 * argument. A `defineQueue` / `defineSubscription` push handler and a
 * `defineWorkflow` handler all run under the **system identity** (RLS disabled) —
 * a `ctx.run`/`context.run` back into a Lunora function from inside one skips
 * every end-user row policy. Matched by callee *name* (the `import`-agnostic,
 * fail-closed convention the other feeders use).
 */
const HANDLER_FACTORIES = new Map([
    ["defineQueue", 0],
    ["defineSubscription", 1],
    ["defineWorkflow", 0],
]);

/** A function a `handler:` member can name — the shapes {@link memberFunctionOf} resolves. */
type HandlerFunction = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

/**
 * The name of a call whose callee is a BARE IDENTIFIER, or `undefined`.
 *
 * Deliberately not the shared `calleeName`, which also answers for a property
 * access (`queues.defineQueue(...)` → `"defineQueue"`). The handler factories
 * this gates on are only ever called bare, and accepting a member name would
 * let an unrelated `x.defineQueue(...)` register a privileged dispatch.
 */
const bareCalleeName = (call: CallExpression): string | undefined => {
    const expression = call.getExpression();

    return Node.isIdentifier(expression) ? expression.getText() : undefined;
};

/** The function the `handler` property on a handler factory's config literal (argument `configIndex`) denotes, or `undefined`. */
const handlerFunctionOf = (call: CallExpression, configIndex: number): HandlerFunction | undefined => {
    const config = call.getArguments()[configIndex];

    if (!config || !Node.isObjectLiteralExpression(config)) {
        return undefined;
    }

    return memberFunctionOf(findObjectProperty(config, "handler"));
};

/** The binding name of a handler parameter at `index`, or `undefined` when the handler has no such parameter. */
const parameterNameNode = (handler: HandlerFunction, index: number): BindingName | undefined => handler.getParameters()[index]?.getNameNode();

/**
 * The local each key of a destructured object parameter (`{ params, run: dispatch }`)
 * is bound to, keyed by the property name. Nested or rest patterns bind no simple local.
 */
const boundLocals = (elements: BindingElement[]): Map<string, string> => {
    const locals = new Map<string, string>();

    for (const element of elements) {
        const nameNode = element.getNameNode();

        if (Node.isIdentifier(nameNode)) {
            locals.set(element.getPropertyNameNode()?.getText() ?? nameNode.getText(), nameNode.getText());
        }
    }

    return locals;
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

/** Array iterators whose first callback parameter is each element — each message, on a batch's `messages`. */
const MESSAGE_ITERATOR_METHODS: ReadonlySet<string> = new Set(["every", "filter", "flatMap", "forEach", "map", "some"]);

/**
 * The text of a queue handler's messages array: `<batch>.messages` for a plain batch
 * parameter, or the local a `{ messages }` batch parameter binds. `undefined` when the
 * handler declares no batch parameter or one that carries no `messages`.
 */
const messagesExpressionOf = (handler: HandlerFunction): string | undefined => {
    const nameNode = parameterNameNode(handler, 1);

    if (nameNode && Node.isIdentifier(nameNode)) {
        return `${nameNode.getText()}.messages`;
    }

    return nameNode && Node.isObjectBindingPattern(nameNode) ? boundLocals(nameNode.getElements()).get("messages") : undefined;
};

/**
 * The first parameter's name of a `<messages>.forEach((m) => …)`-style callback, or
 * `undefined`. Each callback invocation receives one message, so `m.body` is the payload.
 */
const messageParameterOf = (call: CallExpression, messages: string): string | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !MESSAGE_ITERATOR_METHODS.has(callee.getName()) || callee.getExpression().getText() !== messages) {
        return undefined;
    }

    const callback = call.getArguments()[0];

    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return undefined;
    }

    const nameNode = callback.getParameters()[0]?.getNameNode();

    return nameNode && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
};

/**
 * The payload access-path prefixes for a queue handler — the messages array
 * (see {@link messagesExpressionOf}) plus `<message>.body` for each message bound by a
 * `for (… of <messages>)` loop or a `<messages>.forEach((m) => …)`-style callback.
 * Empty when the handler declares no batch parameter.
 */
const queuePayloadPrefixes = (handler: HandlerFunction): string[] => {
    const messages = messagesExpressionOf(handler);

    if (messages === undefined) {
        return [];
    }

    const prefixes = [messages];

    for (const loop of handler.getDescendantsOfKind(SyntaxKind.ForOfStatement)) {
        if (loop.getExpression().getText() !== messages) {
            continue;
        }

        const declarations = loop.getInitializer();
        const binding = Node.isVariableDeclarationList(declarations) ? declarations.getDeclarations()[0]?.getNameNode() : undefined;

        if (binding && Node.isIdentifier(binding)) {
            prefixes.push(`${binding.getText()}.body`);
        }
    }

    // A callback is the other way a message reaches the handler body (`batch.messages.forEach(m => …)`).
    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const message = messageParameterOf(call, messages);

        if (message !== undefined) {
            prefixes.push(`${message}.body`);
        }
    }

    return prefixes;
};

/**
 * What a handler's context parameter exposes: the plain-identifier receiver (`ctx` in
 * `(ctx, batch)`), and for a destructured `({ params, run })` the local bound to
 * `params` (a workflow payload) and the locals bound to dispatch methods (bare callees).
 */
type ContextNames = { params: string | undefined; receiver: string | undefined; runCallees: string[] };

/** The {@link ContextNames} of a handler's first parameter; empty when it has none. */
const contextNamesOf = (handler: HandlerFunction): ContextNames => {
    const nameNode = parameterNameNode(handler, 0);

    if (nameNode && Node.isIdentifier(nameNode)) {
        return { params: undefined, receiver: nameNode.getText(), runCallees: [] };
    }

    if (!nameNode || !Node.isObjectBindingPattern(nameNode)) {
        return { params: undefined, receiver: undefined, runCallees: [] };
    }

    const locals = boundLocals(nameNode.getElements());

    return {
        params: locals.get("params"),
        receiver: undefined,
        // `run` may be aliased (`{ run: dispatch }`); the bare call goes through the local.
        runCallees: [...locals].filter(([key]) => RUN_METHODS.has(key)).map(([, local]) => local),
    };
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
const collectPayload = (handler: HandlerFunction, kind: "queue" | "workflow", context: ContextNames): { names: Set<string>; prefixes: string[] } => {
    // A destructured `{ params }` has no `<context>.params` path, so its local is the payload name.
    const workflowPrefixes = context.receiver === undefined ? [] : [`${context.receiver}.params`];
    const prefixes = kind === "workflow" ? workflowPrefixes : queuePayloadPrefixes(handler);
    const names = new Set<string>(kind === "workflow" && context.params !== undefined ? [context.params] : []);

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
    const segments = functionReferenceSegments(node);

    return segments === undefined ? undefined : { exportName: String(segments.at(-1)), file: segments.slice(0, -1).join("/") };
};

/** Payload-derived privileged dispatches inside one handler. */
const dispatchesInHandler = (handler: HandlerFunction, kind: "queue" | "workflow", relativePath: string): PrivilegedDispatchIR[] => {
    const context = contextNamesOf(handler);
    const payload = collectPayload(handler, kind, context);
    // `ctx.run(...)`, plus a queue's `message.run(...)` — the message-pinned form the
    // docs recommend, dispatching under the same system identity.
    const receivers = new Set([
        ...(context.receiver === undefined ? [] : [context.receiver]),
        ...payload.prefixes.filter((prefix) => prefix.endsWith(".body")).map((prefix) => prefix.slice(0, -".body".length)),
    ]);
    const runCallees = new Set(context.runCallees);
    const found: PrivilegedDispatchIR[] = [];

    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const isReceiverDispatch =
            Node.isPropertyAccessExpression(callee) && RUN_METHODS.has(callee.getName()) && receivers.has(callee.getExpression().getText());
        // A destructured `run(...)` has no receiver to match, so its local name is the callee.
        const isBareDispatch = Node.isIdentifier(callee) && runCallees.has(callee.getText());

        if (!isReceiverDispatch && !isBareDispatch) {
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
            scope: callSiteScopeOf(call),
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

    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        const name = bareCalleeName(call);

        const configIndex = name === undefined ? undefined : HANDLER_FACTORIES.get(name);

        if (configIndex === undefined) {
            continue;
        }

        const handler = handlerFunctionOf(call, configIndex);

        if (handler === undefined) {
            continue;
        }

        // A subscription is a queue: same batch-shaped handler, same payload taint.
        found.push(...dispatchesInHandler(handler, name === "defineWorkflow" ? "workflow" : "queue", relativePath));
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
