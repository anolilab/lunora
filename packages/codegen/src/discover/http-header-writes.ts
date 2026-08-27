import type { CallExpression, NewExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isRequestInputDerived, referencesRequestInput, singleHopInitializer } from "./argument-taint";
import type { InspectableHandler } from "./discover-functions";
import { inlineHandler, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { HttpHeaderWriteIR } from "./ir";

/**
 * Neutralizers that strip or preclude CR/LF in a header value: the framework CR/LF
 * guard (`isSafeHeaderValue`), the URL/URI encoders, and numeric coercions. A value
 * routed through any of these can't carry `\r\n`, so it is not header injection.
 * `String(...)` / `.toString()` are deliberately absent — they stringify but never
 * remove CR/LF, so they are not sanitizers here (`String(Number(x))` is still safe,
 * because the inner `Number(x)` is the neutralizer).
 */
const SANITIZER_CALLEES = new Set(["btoa", "encodeURI", "encodeURIComponent", "isSafeHeaderValue", "Number", "parseFloat", "parseInt"]);

/** The `Headers` mutation methods whose second argument is a header value. */
const HEADER_MUTATORS = new Set(["append", "set"]);

/** The simple name of a call/new callee: the identifier text, or the member name of a property access. */
const calleeName = (callee: TsNode): string => {
    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

/** The literal value of a string-literal / no-substitution-template key node, else `""`. */
const staticHeaderName = (node: TsNode | undefined): string => {
    if (node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) {
        return node.getLiteralText();
    }

    return "";
};

/**
 * True when `root`, or any call nested within it, is a CR/LF-neutralizer call whose
 * argument carries the request input — `encodeURIComponent(request...)`,
 * `Number(request...)` (even wrapped as `String(Number(request...))`), or the CR/LF
 * guard (`isSafeHeaderValue(request...) ? request... : fallback`). Scanning the
 * whole subtree, not just the outermost call, means an inner neutralizer is honored
 * and requiring the sanitizer to reference the request keeps an unrelated call
 * (`isSafeHeaderValue("static") ? request... : x`) from masking a real injection.
 */
const sanitizesRequestInput = (root: TsNode, requestName: string): boolean => {
    const calls = Node.isCallExpression(root)
        ? [root, ...root.getDescendantsOfKind(SyntaxKind.CallExpression)]
        : root.getDescendantsOfKind(SyntaxKind.CallExpression);

    return calls.some((call) => SANITIZER_CALLEES.has(calleeName(call.getExpression())) && referencesRequestInput(call, requestName));
};

/**
 * True when the header value was routed through a CR/LF neutralizer. The value
 * itself and one local `const` hop are inspected (symmetric with the taint check),
 * so `const safe = encodeURIComponent(request...); … safe` is recognized as safe.
 */
const isSanitized = (valueNode: TsNode, requestName: string): boolean => {
    if (sanitizesRequestInput(valueNode, requestName)) {
        return true;
    }

    const hop = singleHopInitializer(valueNode);

    return hop !== undefined && sanitizesRequestInput(hop, requestName);
};

/** True when `valueNode` is request-derived and not routed through a CR/LF sanitizer — an injectable header value. */
const isUnsafe = (valueNode: TsNode, requestName: string): boolean => isRequestInputDerived(valueNode, requestName) && !isSanitized(valueNode, requestName);

/** True when `receiver` is provably a `Headers` instance: a `const h = new Headers(...)` binding, or an `X.headers` member access (a `Response`'s headers). */
const isHeadersReceiver = (receiver: TsNode): boolean => {
    if (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "headers") {
        return true;
    }

    const hop = singleHopInitializer(receiver);

    return hop !== undefined && Node.isNewExpression(hop) && calleeName(hop.getExpression()) === "Headers";
};

/** Resolve `node` to an object literal directly or through one `const` hop, else `undefined`. */
const resolveObjectLiteral = (node: TsNode | undefined): ObjectLiteralExpression | undefined => {
    if (node === undefined) {
        return undefined;
    }

    if (Node.isObjectLiteralExpression(node)) {
        return node;
    }

    const hop = singleHopInitializer(node);

    return hop !== undefined && Node.isObjectLiteralExpression(hop) ? hop : undefined;
};

/** Context threaded through the site collectors — the emit target plus the source attribution. */
interface CollectContext {
    exportName: string;
    relativePath: string;
    requestName: string;
    rows: HttpHeaderWriteIR[];
}

/**
 * Collect unsafe header sites from a headers object literal (`{ "x-host": value }`).
 * Shorthand properties resolve to the identifier value; a spread of a `const base =
 * {...}` object is followed one hop.
 */
const collectFromHeadersObject = (headersObject: ObjectLiteralExpression, via: HttpHeaderWriteIR["via"], context: CollectContext): void => {
    for (const property of headersObject.getProperties()) {
        if (Node.isPropertyAssignment(property)) {
            const valueNode = property.getInitializer();

            if (valueNode !== undefined && isUnsafe(valueNode, context.requestName)) {
                context.rows.push({
                    exportName: context.exportName,
                    file: context.relativePath,
                    headerName: staticHeaderName(property.getNameNode()),
                    line: valueNode.getStartLineNumber(),
                    via,
                });
            }
        } else if (Node.isShorthandPropertyAssignment(property)) {
            const valueNode = property.getNameNode();

            if (isUnsafe(valueNode, context.requestName)) {
                context.rows.push({
                    exportName: context.exportName,
                    file: context.relativePath,
                    headerName: property.getName(),
                    line: valueNode.getStartLineNumber(),
                    via,
                });
            }
        } else if (Node.isSpreadAssignment(property)) {
            const nested = resolveObjectLiteral(property.getExpression());

            if (nested !== undefined) {
                collectFromHeadersObject(nested, via, context);
            }
        }
    }
};

/** Given a `ResponseInit` argument (`{ status, headers }`), scan its `headers` property's object literal. */
const collectFromResponseInit = (init: TsNode | undefined, context: CollectContext): void => {
    const initObject = resolveObjectLiteral(init);

    if (initObject === undefined) {
        return;
    }

    const headersProperty = initObject.getProperty("headers");

    if (headersProperty === undefined || !Node.isPropertyAssignment(headersProperty)) {
        return;
    }

    const headersObject = resolveObjectLiteral(headersProperty.getInitializer());

    if (headersObject !== undefined) {
        collectFromHeadersObject(headersObject, "response-init", context);
    }
};

/** Scan a `new Response(...)` / `new Headers(...)` construction for request-tainted header values. */
const collectFromNewExpression = (newExpression: NewExpression, context: CollectContext): void => {
    const name = calleeName(newExpression.getExpression());

    if (name === "Response") {
        collectFromResponseInit(newExpression.getArguments()[1], context);
    } else if (name === "Headers") {
        const headersObject = resolveObjectLiteral(newExpression.getArguments()[0]);

        if (headersObject !== undefined) {
            collectFromHeadersObject(headersObject, "headers-ctor", context);
        }
    }
};

/** Scan a `Response.json(data, init)` call or a `headers.set/append(name, value)` mutation for request-tainted header values. */
const collectFromCallExpression = (call: CallExpression, context: CollectContext): void => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return;
    }

    const method = callee.getName();
    const receiver = callee.getExpression();

    if (method === "json" && Node.isIdentifier(receiver) && receiver.getText() === "Response") {
        collectFromResponseInit(call.getArguments()[1], context);

        return;
    }

    if (HEADER_MUTATORS.has(method) && isHeadersReceiver(receiver)) {
        const valueNode = call.getArguments()[1];

        if (valueNode !== undefined && isUnsafe(valueNode, context.requestName)) {
            context.rows.push({
                exportName: context.exportName,
                file: context.relativePath,
                headerName: staticHeaderName(call.getArguments()[0]),
                line: valueNode.getStartLineNumber(),
                // `method` is guarded to the two `HEADER_MUTATORS` above, so this covers every case.
                via: method === "set" ? "headers-set" : "headers-append",
            });
        }
    }
};

/** Collect every request-tainted header write inside one `httpAction` handler. */
const headerWritesInHandler = (handler: InspectableHandler, context: CollectContext): void => {
    // Scan from the handler node (not its body) so a concise-body arrow — `httpAction((ctx, req) => new Response(...))` — is covered too.
    for (const newExpression of handler.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        collectFromNewExpression(newExpression, context);
    }

    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        collectFromCallExpression(call, context);
    }
};

/** Collect request-tainted header writes from a single `httpAction(...)` call, or `[]` when it isn't an inspectable `httpAction`. */
const headerWritesFromCall = (call: CallExpression, relativePath: string): HttpHeaderWriteIR[] => {
    const callee = call.getExpression();

    if (!Node.isIdentifier(callee) || callee.getText() !== "httpAction") {
        return [];
    }

    const handler = inlineHandler(call.getArguments()[0]);

    if (handler === undefined) {
        return [];
    }

    // `httpAction((ctx, request) => …)` binds the raw `Request` as the second positional parameter.
    const requestParameter = handler.getParameters()[1];

    if (requestParameter === undefined) {
        return [];
    }

    const nameNode = requestParameter.getNameNode();

    if (!Node.isIdentifier(nameNode)) {
        return []; // a destructured request parameter — skip (fail-safe under-report).
    }

    const rows: HttpHeaderWriteIR[] = [];

    headerWritesInHandler(handler, { exportName: enclosingExportName(call), relativePath, requestName: nameNode.getText(), rows });

    return rows;
};

/** Collect every request-tainted response-header write from one `lunora/` source file. */
const headerWritesInSourceFile = (sourceFile: SourceFile, relativePath: string): HttpHeaderWriteIR[] => {
    const rows: HttpHeaderWriteIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        rows.push(...headerWritesFromCall(call, relativePath));
    }

    return rows;
};

/**
 * Discover response-header writes, inside `httpAction` handlers under `lunora/`,
 * whose value is derived from raw request input with no CR/LF sanitizer — the
 * `http_action_response_header_injection` lint input. Shape/name-based (no
 * type-checker dependency, so it runs pre-`pnpm install`) and fail-safe: a handler
 * whose request parameter or header value can't be statically resolved is skipped.
 */
const discoverHttpHeaderWrites = (project: Project, lunoraDirectory: string): HttpHeaderWriteIR[] => {
    const rows: HttpHeaderWriteIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...headerWritesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverHttpHeaderWrites;
