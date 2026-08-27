import type { ArrowFunction, CallExpression, FunctionExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { collectCallRows } from "./discover-ast";
import type { HttpActionGuardIR } from "./ir";

/** The `httpRoute.<verb>(...)` factory verbs — the root of a typed-REST-route builder chain. */
const HTTP_VERBS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

/** The terminal steps that close a `httpRoute` builder chain into a mountable handler. */
const TERMINAL_STEPS = new Set(["handler", "stream"]);

/** `ctx.run*` forwarders that perform a write through the owning shard — a side effect from the HTTP edge. */
const RUN_SIDE_EFFECTS = new Set(["runAction", "runMutation"]);

/** `ctx.db.<method>` mutating writes. (`insertManyUnsafe` bypasses per-row validation.) */
const DB_WRITE_METHODS = new Set(["delete", "insert", "insertManyUnsafe", "patch", "replace"]);

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** True when `node` is a plain identifier whose text is exactly `name`. */
const isIdentifierNamed = (node: TsNode | undefined, name: string): boolean => node !== undefined && Node.isIdentifier(node) && node.getText() === name;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one (a named ref, a wrapper call, absent). */
const inlineHandler = (argument: TsNode | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/**
 * The local identifier bound to the action context (`ctx`) inside `handler`, or
 * `undefined` when it can't be resolved (so the caller skips — fail-safe under-report).
 *
 * A raw `httpAction((ctx, request) => …)` binds `ctx` as the first positional parameter; a destructured first parameter (`({ auth }) => …`) is not resolved.
 * A typed `httpRoute.<verb>(…).handler(({ ctx, body }) => …)` receives one options object, so the `ctx` binding is its destructured `ctx` element (honoring an alias `{ ctx: c }`); a non-destructured options parameter is not resolved.
 */
const contextBinding = (handler: InspectableHandler, isHttpAction: boolean): string | undefined => {
    const parameter = handler.getParameters()[0];

    if (parameter === undefined) {
        return undefined;
    }

    const nameNode = parameter.getNameNode();

    if (isHttpAction) {
        return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
    }

    // httpRoute options object: find the `ctx` destructure element.
    if (!Node.isObjectBindingPattern(nameNode)) {
        return undefined;
    }

    for (const element of nameNode.getElements()) {
        const property = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();

        if (property === "ctx") {
            const local = element.getNameNode();

            return Node.isIdentifier(local) ? local.getText() : undefined;
        }
    }

    return undefined;
};

/**
 * The first side-effecting call in `handler` reached through the `ctx` binding —
 * a `ctx.runMutation` / `ctx.runAction` forward, or a `ctx.db.<write>` mutation —
 * as a stable label (`runMutation`, `db.insert`, …), or `undefined` when the
 * handler only reads. Descendants are walked in document order, so the earliest
 * side effect is reported deterministically.
 */
const firstSideEffect = (handler: InspectableHandler, contextName: string): string | undefined => {
    const body = handler.getBody();
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);

    // A concise-body arrow (`(ctx) => ctx.runMutation(...)`) has the call *as* its
    // body, which `getDescendantsOfKind` excludes — inspect the body node itself too.
    if (Node.isCallExpression(body)) {
        calls.unshift(body);
    }

    for (const call of calls) {
        const callee = call.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            continue;
        }

        const method = callee.getName();
        const receiver = callee.getExpression();

        if (RUN_SIDE_EFFECTS.has(method) && isIdentifierNamed(receiver, contextName)) {
            return method;
        }

        // `ctx.db.<write>(...)` — the receiver is itself a `ctx.db` member access.
        if (
            DB_WRITE_METHODS.has(method) &&
            Node.isPropertyAccessExpression(receiver) &&
            receiver.getName() === "db" &&
            isIdentifierNamed(receiver.getExpression(), contextName)
        ) {
            return `db.${method}`;
        }
    }

    return undefined;
};

/**
 * True when `handler` reads the request identity through the `ctx` binding —
 * either a direct `ctx.auth` member access (`ctx.auth`, `ctx.auth.userId`,
 * `ctx.auth.getIdentity()`) or a `const { auth } = ctx` destructure. Any such
 * read clears the missing-guard finding (the endpoint consults identity/RLS).
 */
const readsContextAuth = (handler: InspectableHandler, contextName: string): boolean => {
    const body = handler.getBody();

    for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getName() === "auth" && isIdentifierNamed(access.getExpression(), contextName)) {
            return true;
        }
    }

    for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const nameNode = declaration.getNameNode();

        if (!Node.isObjectBindingPattern(nameNode) || !isIdentifierNamed(declaration.getInitializer(), contextName)) {
            continue;
        }

        for (const element of nameNode.getElements()) {
            const property = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();

            if (property === "auth") {
                return true;
            }
        }
    }

    return false;
};

/** The uppercased `httpRoute.<verb>` this `.handler(...)` / `.stream(...)` terminal roots at, or `undefined` when it isn't a Lunora REST route. */
const httpRouteVerbOfTerminal = (terminalCall: CallExpression): string | undefined => {
    const terminalCallee = terminalCall.getExpression();

    if (!Node.isPropertyAccessExpression(terminalCallee) || !TERMINAL_STEPS.has(terminalCallee.getName())) {
        return undefined;
    }

    let node: TsNode = terminalCallee.getExpression();

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            return undefined;
        }

        const step = callee.getName();

        if (HTTP_VERBS.has(step)) {
            const receiver = callee.getExpression();

            return Node.isIdentifier(receiver) && receiver.getText() === "httpRoute" ? step.toUpperCase() : undefined;
        }

        node = callee.getExpression();
    }

    return undefined;
};

/**
 * The evidence row for one HTTP handler that performs a side effect, or
 * `undefined` when the call isn't a side-effecting `httpAction` / `httpRoute`
 * handler (or its `ctx` binding / body isn't statically resolvable).
 */
const guardRowFromCall = (call: CallExpression, relativePath: string): HttpActionGuardIR | undefined => {
    const callee = call.getExpression();

    // Raw `httpAction((ctx, request) => …)`.
    if (Node.isIdentifier(callee) && callee.getText() === "httpAction") {
        const handler = inlineHandler(call.getArguments()[0]);
        const contextName = handler && contextBinding(handler, true);

        if (!handler || contextName === undefined) {
            return undefined;
        }

        const sideEffect = firstSideEffect(handler, contextName);

        return sideEffect === undefined
            ? undefined
            : {
                  exportName: enclosingExportName(call),
                  file: relativePath,
                  kind: "httpAction",
                  line: call.getStartLineNumber(),
                  readsAuth: readsContextAuth(handler, contextName),
                  sideEffect,
              };
    }

    // Typed `httpRoute.<verb>(…).handler(({ ctx, body }) => …)` / `.stream(…)`.
    const method = httpRouteVerbOfTerminal(call);

    if (method === undefined) {
        return undefined;
    }

    const handler = inlineHandler(call.getArguments()[0]);
    const contextName = handler && contextBinding(handler, false);

    if (!handler || contextName === undefined) {
        return undefined;
    }

    const sideEffect = firstSideEffect(handler, contextName);

    return sideEffect === undefined
        ? undefined
        : {
              exportName: enclosingExportName(call),
              file: relativePath,
              kind: "httpRoute",
              line: call.getStartLineNumber(),
              method,
              readsAuth: readsContextAuth(handler, contextName),
              sideEffect,
          };
};

/**
 * Discover `httpAction`/`httpRoute` handlers in `lunora/` that perform a side
 * effect (`ctx.runMutation` / `ctx.runAction` / a `ctx.db.{insert,patch,replace,
 * delete,insertManyUnsafe}` write) and whether each reads `ctx.auth` — the
 * `http_action_missing_auth_guard` lint input. An HTTP endpoint that mutates
 * state or dispatches an action without ever consulting the request identity is
 * an unauthenticated write bypassing identity/RLS at the edge. Only handlers with
 * a resolvable inline body and a resolvable `ctx` binding are recorded (a named
 * handler ref, a wrapper call, or a destructured `ctx` parameter is skipped,
 * fail-safe); read-only handlers (`ctx.runQuery` only) are never recorded.
 * Supplied by the codegen feeder; runtime callers don't produce it, so the lint
 * finds nothing there.
 */
const discoverHttpActionGuards = (project: Project, lunoraDirectory: string): HttpActionGuardIR[] =>
    collectCallRows(project, lunoraDirectory, guardRowFromCall);

export default discoverHttpActionGuards;
