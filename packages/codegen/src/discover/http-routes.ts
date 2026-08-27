import type { CallExpression, Node as TsNode, Project, PropertyAccessExpression, SourceFile } from "ts-morph";
import { Node } from "ts-morph";

import { lunoraRelativePath } from "./discover-ast";
import { listLunoraSourceFiles, unwrapHandlerReturn } from "./discover-functions";
import type { HttpRouteIR, ValidatorIR } from "./ir";
import { parseObjectShape, parseValidator } from "./parse-validator";

/**
 * The `httpRoute.<verb>(...)` factory verbs. Each opens a fresh typed-route
 * builder; the verb is the HTTP method (uppercased) the route binds to.
 */
const HTTP_VERBS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

/** The builder steps that accumulate a validator map keyed by field name. */
const MAP_STEPS = new Set(["body", "params", "searchParams"]);

/** The terminal steps that close a route builder chain into a mountable handler. */
const TERMINAL_STEPS = new Set(["handler", "stream"]);

/** Accumulated state walked out of a `httpRoute` builder chain (terminal → root). */
interface RouteChainState {
    body: Record<string, ValidatorIR>;
    method?: string;
    output?: ValidatorIR;
    params: Record<string, ValidatorIR>;
    path?: string;
    searchParams: Record<string, ValidatorIR>;
    stream: boolean;
}

/**
 * Read the first string-literal argument of a `httpRoute.<verb>(path)` call.
 * A non-literal path (a computed expression) can't be rendered into the OpenAPI
 * document, so it returns `undefined` and the route is skipped.
 */
const readPathLiteral = (call: CallExpression): string | undefined => {
    const first = call.getArguments()[0];

    if (first && Node.isStringLiteral(first)) {
        return first.getLiteralValue();
    }

    return undefined;
};

/** Read the validator-map argument of a `.searchParams({...})` / `.body({...})` / `.params({...})` step. */
const readMapArgument = (call: CallExpression): Record<string, ValidatorIR> => {
    const first = call.getArguments()[0];

    return first && Node.isObjectLiteralExpression(first) ? parseObjectShape(first) : {};
};

/**
 * Resolve the receiver chain's root `httpRoute.<verb>(path)` segment, returning
 * the method + path, or `undefined` when the chain doesn't bottom out in a
 * `httpRoute` verb factory (so it isn't a Lunora REST route).
 */
const readRootVerb = (node: TsNode): { method: string; path: string } | undefined => {
    if (!Node.isCallExpression(node)) {
        return undefined;
    }

    const callee = node.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const verb = callee.getName();

    if (!HTTP_VERBS.has(verb)) {
        return undefined;
    }

    // The receiver of the verb access must be the `httpRoute` identifier (the
    // brand that distinguishes `httpRoute.get(...)` from an unrelated `.get`).
    const receiver = callee.getExpression();

    if (!Node.isIdentifier(receiver) || receiver.getText() !== "httpRoute") {
        return undefined;
    }

    const path = readPathLiteral(node);

    return path === undefined ? undefined : { method: verb.toUpperCase(), path };
};

/**
 * Walk a `httpRoute.<verb>("/p").searchParams({...}).body({...}).output(v).handler(fn)`
 * chain leftward from the terminal call, merging the input maps and recording
 * `.output()`, until it reaches the `httpRoute.<verb>(path)` root. Mirrors
 * `discover-functions`' `argsFromBuilderChain`: chains read terminal → root, so a
 * key set by a later (encountered-first) `.body()` wins over an earlier one —
 * matching the runtime's `{ ...state.body, ...validators }` spread.
 *
 * Returns `undefined` when the chain isn't a Lunora REST route (no `httpRoute`
 * root or no string-literal path).
 */
const walkRouteChain = (terminalCall: CallExpression, terminalStep: string): RouteChainState | undefined => {
    const state: RouteChainState = { body: {}, params: {}, searchParams: {}, stream: terminalStep === "stream" };

    // Start from the receiver of the terminal call's property access.
    const terminalCallee = terminalCall.getExpression();

    if (!Node.isPropertyAccessExpression(terminalCallee)) {
        return undefined;
    }

    let node: TsNode = terminalCallee.getExpression();

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        const step = callee.getName();

        // The verb factory (`.get("/p")`) is the chain root, not an
        // intermediate step — stop so `readRootVerb` reads it (and its path).
        if (HTTP_VERBS.has(step)) {
            break;
        }

        if (MAP_STEPS.has(step)) {
            const map = readMapArgument(node);

            // Earlier-in-source steps are encountered later in this leftward walk,
            // so spread the already-merged map last to let later calls win.
            state[step as "body" | "params" | "searchParams"] = { ...map, ...state[step as "body" | "params" | "searchParams"] };
        } else if (step === "output" && state.output === undefined) {
            const argument = node.getArguments()[0];

            if (argument && Node.isExpression(argument)) {
                state.output = parseValidator(argument);
            }
        }

        node = callee.getExpression();
    }

    const root = readRootVerb(node);

    if (!root) {
        return undefined;
    }

    state.method = root.method;
    state.path = root.path;

    return state;
};

/**
 * Render the SSE chunk type of a `.stream(handler)` terminal — the `R` the
 * handler yields. The handler is the terminal call's only argument; its
 * `AsyncGenerator<R, …>` / `AsyncIterable<R>` return type is unwrapped by
 * `unwrapHandlerReturn` (shared with function discovery), so the same
 * degraded-checker fallbacks apply. `"unknown"` when the argument isn't an
 * inline function expression (e.g. a hoisted identifier).
 */
const chunkTypeFromStreamTerminal = (call: CallExpression): string => {
    const handler = call.getArguments()[0];

    if (!handler || !(Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
        return "unknown";
    }

    return unwrapHandlerReturn(handler);
};

/**
 * Recognise a `httpRoute` builder terminal (`.handler(...)` / `.stream(...)`),
 * returning the fully-walked {@link HttpRouteIR} or `undefined` when the chain
 * isn't a Lunora REST route.
 */
const routeFromTerminal = (call: CallExpression, callee: PropertyAccessExpression, exportName: string, filePath: string): HttpRouteIR | undefined => {
    const step = callee.getName();

    if (!TERMINAL_STEPS.has(step)) {
        return undefined;
    }

    const state = walkRouteChain(call, step);

    if (state?.method === undefined || state.path === undefined) {
        return undefined;
    }

    return {
        body: state.body,
        exportName,
        filePath,
        method: state.method,
        params: state.params,
        path: state.path,
        searchParams: state.searchParams,
        stream: state.stream,
        ...(state.stream ? { chunkType: chunkTypeFromStreamTerminal(call) } : {}),
        ...(state.output ? { output: state.output } : {}),
    };
};

/** Lift every `httpRoute` REST route exported from one source file into {@link HttpRouteIR} entries. */
const discoverFileRoutes = (source: SourceFile, relativePath: string): HttpRouteIR[] => {
    const found: HttpRouteIR[] = [];

    for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const initializer = declaration.getInitializer();

            if (!initializer || !Node.isCallExpression(initializer)) {
                continue;
            }

            const callee = initializer.getExpression();

            if (!Node.isPropertyAccessExpression(callee)) {
                continue;
            }

            const route = routeFromTerminal(initializer, callee, declaration.getName(), relativePath);

            if (route) {
                found.push(route);
            }
        }
    }

    return found;
};

/**
 * Scan all `.ts` files under `lunoraDir` (skipping `_generated/` and `schema.ts`)
 * for `export const x = httpRoute.<verb>(...)…handler(...)` typed REST routes.
 * These are the headline OpenAPI target: each becomes a real `paths` entry.
 */
const discoverHttpRoutes = (project: Project, lunoraDirectory: string): HttpRouteIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const routes: HttpRouteIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        routes.push(...discoverFileRoutes(source, relativePath));
    }

    routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`) || a.filePath.localeCompare(b.filePath));

    return routes;
};

export default discoverHttpRoutes;
