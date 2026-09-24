import type { CallExpression, Identifier, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "../argument-taint";
import type { HttpActionGuardIR } from "../ir";
import { collectCallRows } from "./ast";
import type { InspectableHandler } from "./functions/handler";
import { inlineHandler } from "./functions/handler";

/** The `httpRoute.<verb>(...)` factory verbs — the root of a typed-REST-route builder chain. */
const HTTP_VERBS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

/** The terminal steps that close a `httpRoute` builder chain into a mountable handler. */
const TERMINAL_STEPS = new Set(["handler", "stream"]);

/** `ctx.run*` forwarders that perform a write through the owning shard — a side effect from the HTTP edge. */
const RUN_SIDE_EFFECTS = new Set(["runAction", "runMutation"]);

/** `ctx.db.<method>` mutating writes. (`insertManyUnsafe` bypasses per-row validation.) */
const DB_WRITE_METHODS = new Set(["delete", "insert", "insertManyUnsafe", "patch", "replace"]);

/** True when `node` is a plain identifier whose text is exactly `name`. */
const isIdentifierNamed = (node: TsNode | undefined, name: string): boolean => node !== undefined && Node.isIdentifier(node) && node.getText() === name;

/**
 * The local identifier a destructured handler parameter binds `property` to
 * (honoring an alias `{ ctx: c }`), or `undefined` when the parameter isn't a
 * destructure or doesn't carry `property`.
 */
const destructuredBinding = (nameNode: TsNode | undefined, property: string): string | undefined => {
    if (nameNode === undefined || !Node.isObjectBindingPattern(nameNode)) {
        return undefined;
    }

    for (const element of nameNode.getElements()) {
        const key = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();

        if (key === property) {
            const local = element.getNameNode();

            return Node.isIdentifier(local) ? local.getText() : undefined;
        }
    }

    return undefined;
};

/**
 * The local identifier bound to the action context (`ctx`) inside `handler`, or
 * `undefined` when it can't be resolved (so the caller skips — fail-safe under-report).
 *
 * A raw `httpAction((ctx, request) => …)` binds `ctx` as the first positional parameter; a destructured first parameter (`({ auth }) => …`) is not resolved.
 * A typed `httpRoute.<verb>(…).handler(({ ctx, body }) => …)` receives one options object, so the `ctx` binding is its destructured `ctx` element (honoring an alias `{ ctx: c }`); a non-destructured options parameter is not resolved.
 */
const contextBinding = (handler: InspectableHandler, isHttpAction: boolean): string | undefined => {
    const nameNode = handler.getParameters()[0]?.getNameNode();

    if (nameNode === undefined) {
        return undefined;
    }

    if (isHttpAction) {
        return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
    }

    return destructuredBinding(nameNode, "ctx");
};

/**
 * The local identifier bound to the inbound `Request` inside `handler`, or
 * `undefined` when the handler is given none.
 *
 * A raw `httpAction((ctx, request) => …)` binds it as the second positional
 * parameter; `httpRoute.<verb>(…).stream(({ ctx, request }) => …)` destructures it
 * out of the options object. A `.handler(…)` route is handed the decoded
 * `{ ctx, searchParams, body, params }` and no request at all, so a `headers.get(…)`
 * inside one necessarily reads some *other* `Headers`.
 */
const requestBinding = (handler: InspectableHandler, isHttpAction: boolean): string | undefined => {
    const nameNode = handler.getParameters()[isHttpAction ? 1 : 0]?.getNameNode();

    if (!isHttpAction) {
        return destructuredBinding(nameNode, "request");
    }

    return nameNode !== undefined && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
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

/**
 * Header names that carry a provider webhook signature. Which header a provider
 * signs with is its own choice — `stripe-signature`, `creem-signature`, the
 * Standard-Webhooks `webhook-signature`, `svix-signature`, GitHub's
 * `x-hub-signature-256`, Shopify's `x-shopify-hmac-sha256` — so the shape is
 * matched rather than an allowlist enumerated.
 */
const SIGNATURE_HEADER_NAME = /signature|hmac|digest|(?:^|[_-])sig(?:[_-]|$)/i;

/**
 * True when `call` reads a header off the inbound request bound to `requestName`
 * (`request.headers.get(name)` / `.has(name)`). Anchored on that binding: a read
 * off a fetched response or a locally built `Headers` says nothing about the
 * request that reached this handler.
 */
const isRequestHeaderRead = (call: CallExpression, requestName: string): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || (callee.getName() !== "get" && callee.getName() !== "has")) {
        return false;
    }

    const receiver = callee.getExpression();

    return Node.isPropertyAccessExpression(receiver) && receiver.getName() === "headers" && isIdentifierNamed(receiver.getExpression(), requestName);
};

/** Every string literal at or under `node` — `node` itself included, which `getDescendantsOfKind` leaves out. */
const stringLiteralsOf = (node: TsNode): string[] => [
    ...(Node.isStringLiteral(node) ? [node.getLiteralText()] : []),
    ...node.getDescendantsOfKind(SyntaxKind.StringLiteral).map((literal) => literal.getLiteralText()),
];

/** The string literals of the module-level `const <name> = …` in `sourceFile`, or none when it declares no such constant. */
const constantLiteralsOf = (sourceFile: SourceFile, name: string): string[] => {
    const initializer = sourceFile.getVariableDeclaration(name)?.getInitializer();

    return initializer === undefined ? [] : stringLiteralsOf(initializer);
};

/**
 * The names of the constant whose iteration bound `parameter`: the receiver of the
 * call whose callback declares it
 * (`SIGNATURE_HEADERS.flatMap((name) => request.headers.get(name))`). Empty when the
 * identifier is not such a callback parameter.
 */
const iteratedConstantNames = (parameter: Identifier, sourceFile: SourceFile): string[] => {
    const name = parameter.getText();

    for (let node: TsNode | undefined = parameter.getParent(); node !== undefined; node = node.getParent()) {
        if ((!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) || !node.getParameters().some((candidate) => candidate.getName() === name)) {
            continue;
        }

        const enclosingCall = node.getParent();

        if (!Node.isCallExpression(enclosingCall)) {
            return [];
        }

        const callee = enclosingCall.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            return [];
        }

        const receiver = callee.getExpression();

        return Node.isIdentifier(receiver) ? constantLiteralsOf(sourceFile, receiver.getText()) : [];
    }

    return [];
};

/**
 * The header names one header read can name — resolved from *its own argument*,
 * never from the surrounding body: a literal
 * (`request.headers.get("stripe-signature")`), a module constant it forwards
 * (`…get(SIGNATURE_HEADER)`), or the constant a callback parameter iterates
 * (`SIGNATURE_HEADERS.flatMap((name) => …get(name))`). Anything else resolves to
 * nothing, so the read proves nothing.
 */
const headerNamesRead = (call: CallExpression): string[] => {
    const argument = call.getArguments()[0];

    if (argument === undefined) {
        return [];
    }

    if (Node.isStringLiteral(argument)) {
        return [argument.getLiteralText()];
    }

    if (!Node.isIdentifier(argument)) {
        return [];
    }

    const sourceFile = call.getSourceFile();
    const named = constantLiteralsOf(sourceFile, argument.getText());

    return named.length > 0 ? named : iteratedConstantNames(argument, sourceFile);
};

/**
 * True when `handler` authenticates the request by *signature* rather than by
 * identity: it reads a header off its own inbound request (`requestName`) whose
 * name resolves to a signature-shaped one — written inline
 * (`request.headers.get("stripe-signature")`) or held in a module constant the
 * handler forwards (`SIGNATURE_HEADERS.flatMap((name) => request.headers.get(name))`).
 *
 * Both halves are anchored on the read itself: the receiver must be the handler's
 * own request, and the name must come from that read's argument. A signature-shaped
 * string loose in the body (an error message, an unrelated constant) and a header
 * read off anything else are each, alone or together, not evidence.
 *
 * A provider webhook carries no user identity, so `ctx.auth` is meaningless on
 * it and the missing-guard finding is unsatisfiable — the endpoint is
 * authenticated, just not by the thing the rule looks for. Recognising the
 * signature read clears it. FN-biased like the rest of the advisor's negative
 * proofs: a real unauthenticated write that happens to read a signature-named
 * request header stays quiet, which is cheaper than a permanent warning on the
 * canonical webhook shape that trains users to ignore the advisor.
 */
const verifiesWebhookSignature = (handler: InspectableHandler, requestName: string | undefined): boolean => {
    if (requestName === undefined) {
        return false;
    }

    const body = handler.getBody();
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);

    if (Node.isCallExpression(body)) {
        calls.unshift(body);
    }

    return calls.some((call) => isRequestHeaderRead(call, requestName) && headerNamesRead(call).some((name) => SIGNATURE_HEADER_NAME.test(name)));
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

        if (!handler || contextName === undefined || verifiesWebhookSignature(handler, requestBinding(handler, true))) {
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

    if (!handler || contextName === undefined || verifiesWebhookSignature(handler, requestBinding(handler, false))) {
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
 * fail-safe); read-only handlers (`ctx.runQuery` only) are never recorded, and
 * neither are handlers that authenticate by provider signature instead of by
 * identity (see `verifiesWebhookSignature`).
 * Supplied by the codegen feeder; runtime callers don't produce it, so the lint
 * finds nothing there.
 */
const discoverHttpActionGuards = (project: Project, lunoraDirectory: string): HttpActionGuardIR[] =>
    collectCallRows(project, lunoraDirectory, guardRowFromCall);

export default discoverHttpActionGuards;
