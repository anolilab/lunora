import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { CallExpression, Identifier, Project, PropertyAccessExpression, SourceFile, Type } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "./ir.js";
import { parseObjectShape } from "./parse-validator.js";
import sanitizeNamespace from "./paths.js";

const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);

/** Detects a standalone `any` token in a rendered type (degraded type-checker mode). */
const ANY_TOKEN_RE = /\bany\b/u;

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE = /\.ts$/u;

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
 * Module specifiers a registration factory (`query`/`mutation`/`action`/their
 * `internal*` twins) may legitimately come from: the public `@cirrus/server`
 * surface, or the generated `_generated/server` re-export. The latter is the
 * Convex idiom — user code imports `query`/`mutation`/`v` from `_generated/server`
 * so `v.id(...)` is table-name typed — and discovery must treat those imports as
 * real registrations too, not local bindings.
 */
const GENERATED_SERVER_RE = /(?:^|\/)_generated\/server(?:\.js)?$/u;

const isCirrusSurfaceModule = (moduleSpecifier: string): boolean =>
    moduleSpecifier === "@cirrus/server" || GENERATED_SERVER_RE.test(moduleSpecifier);

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@cirrus/server` or the
 * generated `_generated/server` re-export). This handles aliasing like
 * `import { query as q }` where the call site uses `q` but the registration kind
 * is `query`. Returns `undefined` when the identifier is not imported from the
 * Cirrus surface, so we don't accidentally pick up a local `const query = ...`.
 */
const resolveCalleeKind = (identifier: Identifier): string | undefined => {
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

        // Only trust identifiers imported from the Cirrus surface (the public
        // package or the generated `_generated/server` re-export).
        if (!isCirrusSurfaceModule(moduleSpecifier)) {
            return undefined;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@cirrus/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return undefined;
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
 * True when a type's own symbol resolves to a non-exported interface/type-alias
 * declared in the handler's source file — i.e. a name unreachable from
 * `_generated/api.ts`.
 */
const symbolDeclaredUnreachable = (type: Type, handlerFilePath: string): boolean => {
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

    return false;
};

/** Composite child types of `type` (type arguments + union/intersection members) to recurse into. */
const childTypes = (type: Type): Type[] => {
    const children = [...type.getTypeArguments()];

    if (type.isUnion()) {
        children.push(...type.getUnionTypes());
    }

    if (type.isIntersection()) {
        children.push(...type.getIntersectionTypes());
    }

    return children;
};

/**
 * Type-tree walker: returns true if any reachable symbol's declaration lives
 * in the handler's own source file but isn't exported (so it cannot be
 * referenced by name from anywhere outside that file).
 */
const referencesUnreachableLocalType = (type: Type, handlerFilePath: string, seen = new Set<Type>()): boolean => {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (symbolDeclaredUnreachable(type, handlerFilePath)) {
        return true;
    }

    return childTypes(type).some((child) => referencesUnreachableLocalType(child, handlerFilePath, seen));
};

/**
 * Render a handler's resolved return type via ts-morph's type checker. Unwraps
 * the outer `Promise&lt;…>` so the emitted `FunctionReference&lt;Kind, Args, Return>`
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
    if (ANY_TOKEN_RE.test(rendered)) {
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
 * named `query` on some other object. Returns `undefined` when this isn't a Cirrus
 * builder terminal.
 */
const discoverBuilderProcedure = (call: CallExpression, callee: PropertyAccessExpression): DiscoveredFunction | undefined => {
    const method = callee.getName();

    if (!FUNCTION_KINDS.has(method)) {
        return undefined;
    }

    const receiver = callee.getExpression();
    const receiverType = receiver.getType();

    if (!receiverType.getProperty("__cirrusProcedure")) {
        return undefined;
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
 * Recursively collect `.ts` files under a cirrus source directory, skipping
 * `_generated/`, `node_modules/`, and `schema.ts`. Shared by function and
 * migration discovery so both walk the same file set.
 */
const listCirrusSourceFiles = (directory: string, accumulator: string[] = []): string[] => {
    let entries: string[];

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

/**
 * Classify a top-level `export const x = …` initializer call as a Cirrus
 * registration, or `undefined` when it isn't one. Handles both the bare-factory
 * form (`query({...})` / `internalQuery({...})`) and the builder terminal
 * (`c.query(...)`).
 */
const discoverFromCall = (call: CallExpression): DiscoveredFunction | undefined => {
    const callee = call.getExpression();

    if (Node.isPropertyAccessExpression(callee)) {
        return discoverBuilderProcedure(call, callee);
    }

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const calleeName = resolveCalleeKind(callee);

    if (!calleeName) {
        return undefined;
    }

    if (FUNCTION_KINDS.has(calleeName)) {
        return { args: argsFromCall(call), kind: calleeName, returnType: returnTypeFromCall(call), visibility: "public" };
    }

    const internalKind = INTERNAL_FACTORIES[calleeName];

    if (internalKind) {
        return { args: argsFromCall(call), kind: internalKind, returnType: returnTypeFromCall(call), visibility: "internal" };
    }

    return undefined;
};

/** Lift every Cirrus registration in one source file into {@link FunctionIR} entries. */
const discoverFileFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const initializer = declaration.getInitializer();

            if (initializer?.getKind() !== SyntaxKind.CallExpression) {
                continue;
            }

            const discovered = discoverFromCall(initializer as CallExpression);

            if (!discovered) {
                continue;
            }

            found.push({
                args: discovered.args,
                exportName: declaration.getName(),
                filePath: relativePath,
                kind: discovered.kind as FunctionIR["kind"],
                returnType: discovered.returnType,
                visibility: discovered.visibility,
            });
        }
    }

    return found;
};

/**
 * Detect namespace collisions: two distinct file paths that sanitize to the
 * same identifier (e.g. `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`).
 * Without this guard, emit silently produces duplicate `ApiTypes` keys and an
 * ambiguous dispatch table.
 *
 * Migrations are intentionally NOT considered here: the emitted `CIRRUS_MIGRATIONS`
 * table keys on the migration `id` (uniqueness-checked separately during migration
 * discovery), not on the sanitized namespace, and `emitServer` aliases imports by
 * exact `filePath`. So a migration-only file that sanitizes to the same namespace
 * as a function file cannot collide — only function↔function pairs can.
 */
const assertNoNamespaceCollision = (functions: ReadonlyArray<FunctionIR>): void => {
    const namespaceOrigins = new Map<string, string>();

    for (const entry of functions) {
        const namespace = sanitizeNamespace(entry.filePath);
        const prior = namespaceOrigins.get(namespace);

        if (prior && prior !== entry.filePath) {
            throw Object.assign(
                new Error(
                    `Namespace collision: "${prior}" and "${entry.filePath}" both resolve to "${namespace}". Rename one of the files so the JS-identifier-sanitized names differ. (note: case-insensitive filesystems may also cause this — \`foo\` and \`FOO\` map to the same identifier)`,
                ),
                { code: "NAMESPACE_COLLISION", name: "CirrusError", paths: [prior, entry.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, entry.filePath);
    }
};

/**
 * Scan all .ts files under `cirrusDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
const discoverFunctions = (project: Project, cirrusDirectory: string): FunctionIR[] => {
    const filePaths = listCirrusSourceFiles(cirrusDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.addSourceFileAtPath(filePath);
        const relativePath = relative(cirrusDirectory, filePath).split(sep).join("/").replace(TS_EXTENSION_RE, "");

        functions.push(...discoverFileFunctions(source, relativePath));
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    assertNoNamespaceCollision(functions);

    return functions;
};

export { discoverFunctions, listCirrusSourceFiles };
