import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { CallExpression, Identifier, Project, PropertyAccessExpression, SourceFile, Type } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "./ir.js";
import { parseObjectShape } from "./parse-validator.js";
import { sanitizeNamespace } from "./paths.js";

const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);

/**
 * Internal factory names exported from `@cirrus/server`, mapped to the kind
 * they register. A call to one of these marks the function `internal`: callable
 * server-side via `ctx.run*` but absent from the client-facing `api`.
 */
const INTERNAL_FACTORIES: Record<string, "action" | "mutation" | "query"> = {
    internalAction: "action",
    internalMutation: "mutation",
    internalQuery: "query",
};

interface DiscoveredFunction {
    args: Record<string, ValidatorIR>;
    kind: string;
    returnType: string;
    visibility: "internal" | "public";
}

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@cirrus/server`). This
 * handles aliasing like `import { query as q }` where the call site uses `q`
 * but the registration kind is `query`. Returns `null` when the identifier
 * is not imported from `@cirrus/server`, so we don't accidentally pick up
 * a local `const query = ...`.
 */
const resolveCalleeKind = (identifier: Identifier): string | null => {
    const symbol = identifier.getSymbol();

    // No type-checker info at all (no tsconfig wired up). Fall back to the
    // surface text — preserves the prior behaviour for users that haven't
    // configured ts-morph with a real project.
    if (!symbol) {
        return identifier.getText();
    }

    const declarations = symbol.getDeclarations();

    for (const declaration of declarations) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getImportDeclaration();
        const moduleSpecifier = importDeclaration.getModuleSpecifierValue();

        // Only trust identifiers imported from the public Cirrus surface.
        if (moduleSpecifier !== "@cirrus/server") {
            return null;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@cirrus/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return null;
};

/**
 * Recursively collect `.ts` files under a cirrus source directory, skipping
 * `_generated/`, `node_modules/`, and `schema.ts`. Shared by function and
 * migration discovery so both walk the same file set.
 */
export const listCirrusSourceFiles = (directory: string, accumulator: string[] = []): string[] => {
    let entries: string[] = [];

    try {
        entries = readdirSync(directory);
    } catch {
        return accumulator;
    }

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = statSync(full);

        if (info.isDirectory()) {
            if (entry === "_generated" || entry === "node_modules") {
                continue;
            }

            listCirrusSourceFiles(full, accumulator);
        } else if (info.isFile() && extname(entry) === ".ts" && entry !== "schema.ts") {
            accumulator.push(full);
        }
    }

    return accumulator;
};

/** Inspect a `query({ args, handler })` call and pull out the args validator map. */
const argsFromCall = (call: CallExpression): Record<string, ValidatorIR> => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return {};
    }

    const argsProperty = first.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        return {};
    }

    return parseObjectShape(initializer);
};

/**
 * Render a handler's resolved return type via ts-morph's type checker. Unwraps
 * the outer `Promise<…>` so the emitted `FunctionReference<Kind, Args, Return>`
 * matches what callers see post-await. Shared by the object-literal `query(...)`
 * path and the builder terminal (`c.query(...)`) path.
 *
 * Returns `"unknown"` when the type checker can't resolve enough context —
 * typical when running against a stand-alone fixture without a tsconfig.
 */
const unwrapHandlerReturn = (handler: Node): string => {
    const signature = handler.getType().getCallSignatures()[0];

    if (!signature) {
        return "unknown";
    }

    let returnType = signature.getReturnType();

    // Unwrap a single layer of `Promise<…>` / `AsyncIterable<…>` /
    // `AsyncGenerator<…, …, …>`. The runtime awaits / iterates the handler,
    // so callers should see the inner element type — not the wrapper.
    const symbol = returnType.getSymbol() ?? returnType.getAliasSymbol();
    const wrapperName = symbol?.getName();

    if (wrapperName === "Promise" || wrapperName === "AsyncIterable" || wrapperName === "AsyncIterableIterator" || wrapperName === "AsyncGenerator") {
        const innerTypeArgument = returnType.getTypeArguments()[0];

        if (innerTypeArgument) {
            returnType = innerTypeArgument;
        }
    }

    const rendered = returnType.getText(handler);

    // `any`/empty fall back to `unknown` so downstream typings stay strict.
    if (!rendered || rendered === "any" || rendered === "never") {
        return "unknown";
    }

    // If `any` appears as a standalone identifier anywhere in the rendered
    // type (e.g. `{ channelId: any; ... }`), the type checker is in degraded
    // mode — typically because the consuming project lacks the tsconfig
    // wiring to resolve `@cirrus/server`/`@cirrus/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    if (/\bany\b/u.test(rendered)) {
        return "unknown";
    }

    // ts-morph renders types relative to the handler's enclosing node, so a
    // locally-declared (non-exported) interface like `interface CursorDoc {…}`
    // inside `cursors.ts` shows up as the bare name `CursorDoc[]` — which is
    // unreachable from `_generated/api.ts` and produces TS2304 on compile.
    // Detect that case via the type symbol's declaration and fall back to
    // `unknown` rather than emitting unresolvable identifiers.
    if (referencesUnreachableLocalType(returnType, handler.getSourceFile().getFilePath())) {
        return "unknown";
    }

    return rendered;
};

/**
 * Pull the handler's return type out of an object-literal `query/mutation/action`
 * call (the `{ args, handler }` form).
 */
const returnTypeFromCall = (call: CallExpression): string => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return "unknown";
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return "unknown";
    }

    const initializer = handlerProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    return unwrapHandlerReturn(initializer);
};

/**
 * Pull the handler's return type out of a builder terminal call. Here the
 * handler is the first (and only) argument — `c.query(({ ctx, args }) => …)` —
 * not a `handler:` property.
 */
const returnTypeFromBuilderCall = (call: CallExpression): string => {
    const handler = call.getArguments()[0];

    if (!handler || !(Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
        return "unknown";
    }

    return unwrapHandlerReturn(handler);
};

/**
 * Walk a builder chain leftward from the terminal receiver, merging every
 * `.input({...})` argument into one args record. Chains read terminal → root,
 * so a key set by a later `.input()` (encountered first) must win over an
 * earlier one — hence `{ ...earlier, ...merged }`, mirroring the runtime's
 * `{ ...state.args, ...validators }` spread order.
 */
const argsFromBuilderChain = (receiver: Node): Record<string, ValidatorIR> => {
    let merged: Record<string, ValidatorIR> = {};
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "input") {
            const argument = node.getArguments()[0];

            if (argument && Node.isObjectLiteralExpression(argument)) {
                merged = { ...parseObjectShape(argument), ...merged };
            }
        }

        node = chainCallee.getExpression();
    }

    return merged;
};

/**
 * Recognise a builder terminal registration (`c.query(...)` / `.mutation(...)`
 * / `.action(...)`). The terminal property name is the kind. The receiver must
 * carry the `__cirrusProcedure` brand so we don't pick up an unrelated method
 * named `query` on some other object. Returns `null` when this isn't a Cirrus
 * builder terminal.
 */
const discoverBuilderProcedure = (call: CallExpression, callee: PropertyAccessExpression): DiscoveredFunction | null => {
    const method = callee.getName();

    if (!FUNCTION_KINDS.has(method)) {
        return null;
    }

    const receiver = callee.getExpression();
    const receiverType = receiver.getType();

    if (!receiverType.getProperty("__cirrusProcedure")) {
        return null;
    }

    return {
        args: argsFromBuilderChain(receiver),
        kind: method,
        returnType: returnTypeFromBuilderCall(call),
        // Internal builders carry an extra `__cirrusVisibility: "internal"`
        // brand the public builders don't declare, so its mere presence marks
        // the procedure internal.
        visibility: receiverType.getProperty("__cirrusVisibility") ? "internal" : "public",
    };
};

/**
 * Type-tree walker: returns true if any reachable symbol's declaration lives
 * in the handler's own source file but isn't exported (so it cannot be
 * referenced by name from anywhere outside that file).
 */
const referencesUnreachableLocalType = (type: Type, handlerFilePath: string, seen: Set<Type> = new Set()): boolean => {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    for (const candidate of [type.getSymbol(), type.getAliasSymbol()]) {
        if (!candidate) {
            continue;
        }

        for (const declaration of candidate.getDeclarations()) {
            const declarationFile = declaration.getSourceFile();

            if (declarationFile.isInNodeModules() || declarationFile.isDeclarationFile()) {
                continue;
            }

            if (declarationFile.getFilePath() !== handlerFilePath) {
                continue;
            }

            if ((Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)) && !declaration.isExported()) {
                return true;
            }
        }
    }

    for (const argument of type.getTypeArguments()) {
        if (referencesUnreachableLocalType(argument, handlerFilePath, seen)) {
            return true;
        }
    }

    if (type.isUnion()) {
        for (const component of type.getUnionTypes()) {
            if (referencesUnreachableLocalType(component, handlerFilePath, seen)) {
                return true;
            }
        }
    }

    if (type.isIntersection()) {
        for (const component of type.getIntersectionTypes()) {
            if (referencesUnreachableLocalType(component, handlerFilePath, seen)) {
                return true;
            }
        }
    }

    return false;
};

/**
 * Scan all .ts files under `cirrusDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
export const discoverFunctions = (project: Project, cirrusDirectory: string): FunctionIR[] => {
    const filePaths = listCirrusSourceFiles(cirrusDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.addSourceFileAtPath(filePath);
        const relativePath = relative(cirrusDirectory, filePath).split(sep).join("/").replace(/\.ts$/u, "");

        for (const statement of source.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const initializer = declaration.getInitializer();

                if (initializer?.getKind() !== SyntaxKind.CallExpression) {
                    continue;
                }

                const call = initializer as CallExpression;
                const callee = call.getExpression();

                let discovered: DiscoveredFunction | null = null;

                if (Node.isIdentifier(callee)) {
                    const calleeName = resolveCalleeKind(callee);

                    if (calleeName && FUNCTION_KINDS.has(calleeName)) {
                        discovered = { args: argsFromCall(call), kind: calleeName, returnType: returnTypeFromCall(call), visibility: "public" };
                    } else if (calleeName && INTERNAL_FACTORIES[calleeName]) {
                        discovered = {
                            args: argsFromCall(call),
                            kind: INTERNAL_FACTORIES[calleeName],
                            returnType: returnTypeFromCall(call),
                            visibility: "internal",
                        };
                    }
                } else if (Node.isPropertyAccessExpression(callee)) {
                    discovered = discoverBuilderProcedure(call, callee);
                }

                if (!discovered) {
                    continue;
                }

                functions.push({
                    args: discovered.args,
                    exportName: declaration.getName(),
                    filePath: relativePath,
                    kind: discovered.kind as FunctionIR["kind"],
                    returnType: discovered.returnType,
                    visibility: discovered.visibility,
                });
            }
        }
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    // Detect namespace collisions: two distinct file paths that sanitize to
    // the same identifier (e.g. `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`).
    // Without this guard, emit silently produces duplicate `ApiTypes` keys
    // and an ambiguous dispatch table.
    const namespaceOrigins = new Map<string, string>();

    for (const function_ of functions) {
        const namespace = sanitizeNamespace(function_.filePath);
        const prior = namespaceOrigins.get(namespace);

        if (prior && prior !== function_.filePath) {
            throw Object.assign(
                new Error(
                    `Namespace collision: "${prior}" and "${function_.filePath}" both resolve to "${namespace}". Rename one of the files so the JS-identifier-sanitized names differ. (note: case-insensitive filesystems may also cause this — \`foo\` and \`FOO\` map to the same identifier)`,
                ),
                { code: "NAMESPACE_COLLISION", name: "CirrusError", paths: [prior, function_.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, function_.filePath);
    }

    return functions;
};
