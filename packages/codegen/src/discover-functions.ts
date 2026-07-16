import { lstatSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type {
    ArrowFunction,
    CallExpression,
    FunctionExpression,
    Identifier,
    Project,
    SourceFile,
    Symbol as TsSymbol,
    Type,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "./ir";
import { parseObjectShape } from "./parse-validator";
import sanitizeNamespace from "./paths";

const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);

/**
 * Detects a standalone `any` type token in a rendered type (degraded
 * type-checker mode). The negative lookahead excludes a property *key* named
 * `any` (`{ any: string }` / `{ any?: T }`) — a key is always followed by `:` /
 * `?:`, a real `any` type never is. String-literal type members (`kind: "any"`,
 * `"any" | "all"`) are removed via {@link STRING_LITERAL_SPAN_RE} before this
 * runs, so a discriminant literal `"any"` no longer degrades the whole type.
 */
const ANY_TOKEN_RE = /\bany\b(?!\s*(?:\?\s*)?:)/u;

/**
 * String / template literal *type* spans in a rendered type. Their text is data,
 * not a type token, so an `any` inside one (`kind: "any"`) must not trip
 * degraded-mode detection; callers strip these before testing {@link ANY_TOKEN_RE}.
 */
const STRING_LITERAL_SPAN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

/** JS identifier allowlist — mirrors `emit.ts`'s `IDENTIFIER_RE`, gating raw splice of a property name. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Render an expanded object-type property key for splicing into generated TS:
 * bare when it's a JS identifier, otherwise JSON-quoted (a valid TS member name).
 * Mirrors `emit.ts`'s `renderPropertyKey` so this expansion path can't inject a
 * non-identifier property name (e.g. `"a; b"`) verbatim into `_generated/*`.
 */
const renderExpandedPropertyKey = (propertyName: string): string => (IDENTIFIER_RE.test(propertyName) ? propertyName : JSON.stringify(propertyName));

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE = /\.ts$/u;

/** Lunora-relative module path for a source file: dir-relative, POSIX separators, no `.ts`. */
const lunoraRelativePath = (lunoraDirectory: string, filePath: string): string =>
    relative(lunoraDirectory, filePath).split(sep).join("/").replace(TS_EXTENSION_RE, "");

/**
 * Internal factory names exported from `@lunora/server`, mapped to the kind
 * they register. A call to one of these marks the function `internal`: callable
 * server-side via `ctx.run*` but absent from the client-facing `api`.
 */
const INTERNAL_FACTORIES: Record<string, "action" | "mutation" | "query"> = {
    internalAction: "action",
    internalMutation: "mutation",
    internalQuery: "query",
};

/**
 * Connection-lifecycle factory names exported from `@lunora/server`, mapped to
 * the lifecycle side they fire on. A call to one of these registers an internal
 * mutation tagged `lifecycle: "connect" | "disconnect"` so emit collects it into
 * the `LUNORA_LIFECYCLE_HOOKS` manifest the DO dispatches on socket open/close.
 */
const LIFECYCLE_FACTORIES: Record<string, "connect" | "disconnect"> = {
    onConnect: "connect",
    onDisconnect: "disconnect",
};

interface DiscoveredFunction {
    args: Record<string, ValidatorIR>;
    kind: string;
    lifecycle?: "connect" | "disconnect";
    returnType: string;
    visibility: "internal" | "public";
}

/**
 * Module specifiers a registration factory (`query`/`mutation`/`action`/their
 * `internal*` twins) may legitimately come from: the public `@lunora/server`
 * surface, or the generated `_generated/server` re-export. The latter is the
 * Convex idiom — user code imports `query`/`mutation`/`v` from `_generated/server`
 * so `v.id(...)` is table-name typed — and discovery must treat those imports as
 * real registrations too, not local bindings.
 */
const GENERATED_SERVER_RE = /(?:^|\/)_generated\/server(?:\.js)?$/u;

const isLunoraSurfaceModule = (moduleSpecifier: string): boolean => moduleSpecifier === "@lunora/server" || GENERATED_SERVER_RE.test(moduleSpecifier);

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@lunora/server` or the
 * generated `_generated/server` re-export). This handles aliasing like
 * `import { query as q }` where the call site uses `q` but the registration kind
 * is `query`. Returns `undefined` when the identifier is not imported from the
 * Lunora surface, so we don't accidentally pick up a local `const query = ...`.
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

        // Only trust identifiers imported from the Lunora surface (the public
        // package or the generated `_generated/server` re-export).
        if (!isLunoraSurfaceModule(moduleSpecifier)) {
            return undefined;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@lunora/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return undefined;
};

/**
 * Resolve a builder-terminal chain's root identifier (`query`/`mutation`/...) to
 * its visibility, walking leftward through the `.input()` / `.use()` / `.output()`
 * steps to the root and resolving it by import name via {@link resolveCalleeKind}.
 * Returns `"public"` / `"internal"` for a Lunora builder root, or `undefined`
 * when the chain doesn't root at one (so an unrelated `obj.query(...)` method call
 * isn't mistaken for a registration). Import-name based, so it doesn't depend on
 * the `@lunora/server` types being installed/resolvable.
 */
const resolveBuilderRootKind = (receiver: Node, followedLocal = false): "internal" | "public" | undefined => {
    let current: Node = receiver;

    // Each builder step (`x.input({...})`, `x.use(...)`, `x.output(...)`) is a
    // CallExpression whose callee is a PropertyAccess; descend to its receiver.
    while (Node.isCallExpression(current)) {
        const inner = current.getExpression();

        if (!Node.isPropertyAccessExpression(inner)) {
            return undefined;
        }

        current = inner.getExpression();
    }

    if (!Node.isIdentifier(current)) {
        return undefined;
    }

    const rootName = resolveCalleeKind(current);

    if (rootName === undefined) {
        // The root identifier didn't resolve to an imported Lunora factory. It
        // may instead be a LOCAL const bound to a partially-applied builder
        // (`const b = mutation.input({...}); export const x = b.mutation(...)`).
        // Follow the const's initializer ONE hop and re-resolve, so the chain
        // is still discovered under degraded types (where the `__lunoraProcedure`
        // brand can't resolve). Bounded to a single hop so a `const a = b; const
        // b = a;` cycle can't loop.
        if (followedLocal) {
            return undefined;
        }

        const declaration = current.getSymbol()?.getValueDeclaration();

        if (declaration && Node.isVariableDeclaration(declaration)) {
            const initializer = declaration.getInitializer();

            return initializer ? resolveBuilderRootKind(initializer, true) : undefined;
        }

        return undefined;
    }

    if (FUNCTION_KINDS.has(rootName)) {
        return "public";
    }

    return INTERNAL_FACTORIES[rootName] ? "internal" : undefined;
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
 * An object type whose members we can faithfully reproduce structurally: a plain
 * object/interface with no call/construct signatures and no index signatures
 * (those can't be re-expressed as `{ name: type; … }` without losing meaning).
 */
const isExpandableObject = (type: Type): boolean => {
    if (!type.isObject() || type.isArray() || type.isTuple()) {
        return false;
    }

    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        return false;
    }

    return type.getStringIndexType() === undefined && type.getNumberIndexType() === undefined;
};

/**
 * Type-tree walker: returns true if any reachable symbol's declaration lives in
 * the handler's own source file but isn't exported (so it cannot be referenced
 * by name from `_generated/`). Descends type arguments, union/intersection
 * members, **and** object property types — the last so an anonymous object that
 * embeds an unreachable interface (`{ post: PostDoc }`) isn't mistaken for safe.
 */
const referencesUnreachableLocalType = (type: Type, node: Node, handlerFilePath: string, seen = new Set<Type>()): boolean => {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (symbolDeclaredUnreachable(type, handlerFilePath)) {
        return true;
    }

    if (childTypes(type).some((child) => referencesUnreachableLocalType(child, node, handlerFilePath, seen))) {
        return true;
    }

    if (!isExpandableObject(type)) {
        return false;
    }

    return type.getProperties().some((property) => referencesUnreachableLocalType(property.getTypeAtLocation(node), node, handlerFilePath, seen));
};

/** Is `property` declared optional (`name?: …`)? */
const isOptionalProperty = (property: TsSymbol, propertyType: Type): boolean => {
    const declaration = property.getValueDeclaration() ?? property.getDeclarations()[0];

    if (declaration && (Node.isPropertySignature(declaration) || Node.isPropertyDeclaration(declaration)) && declaration.hasQuestionToken()) {
        return true;
    }

    return propertyType.isUnion() && propertyType.getUnionTypes().some((member) => member.isUndefined());
};

/** Depth ceiling so a pathological nested type can't blow the stack — beyond it we bail to `unknown`. */
const MAX_EXPANSION_DEPTH = 8;

/** Shared type alias for the recursive expand callback passed to branch helpers. */
type ExpandFunction = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>) => string | undefined;

/**
 * Expand an array type; returns `undefined` when the element can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandArrayType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const element = type.getArrayElementType();
    const rendered = element ? expand(element, node, handlerFilePath, depth, nextSeen) : undefined;

    if (rendered === undefined) {
        return undefined;
    }

    return element?.isUnion() ? `(${rendered})[]` : `${rendered}[]`;
};

/**
 * Expand a union type; returns `undefined` when any member can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandUnionType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const parts: string[] = [];

    for (const member of type.getUnionTypes()) {
        const rendered = expand(member, node, handlerFilePath, depth, nextSeen);

        if (rendered === undefined) {
            return undefined;
        }

        parts.push(rendered);
    }

    return parts.join(" | ");
};

/**
 * Expand an object type's properties; returns `undefined` when any property can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandObjectType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    if (!isExpandableObject(type)) {
        return undefined;
    }

    const parts: string[] = [];

    for (const property of type.getProperties()) {
        const propertyType = property.getTypeAtLocation(node);
        const optional = isOptionalProperty(property, propertyType);
        // Optionality re-adds `| undefined` to the resolved type; drop it so the
        // emitted property reads `name?: T`, not `name?: T | undefined`.
        const valueMembers = optional && propertyType.isUnion() ? propertyType.getUnionTypes().filter((member) => !member.isUndefined()) : [propertyType];

        const rendered: string[] = [];

        for (const member of valueMembers) {
            const text = expand(member, node, handlerFilePath, depth + 1, nextSeen);

            if (text === undefined) {
                return undefined;
            }

            rendered.push(text);
        }

        parts.push(`${renderExpandedPropertyKey(property.getName())}${optional ? "?" : ""}: ${rendered.join(" | ")}`);
    }

    return parts.length > 0 ? `{ ${parts.join("; ")} }` : "{}";
};

/**
 * Structurally expand a return type that references a non-exported local type,
 * so the generated `FunctionReference` carries the real shape (`PostDoc[]` →
 * `{ _id: Id&lt;"posts"&gt;; … }[]`) instead of erasing to `unknown`. Reachable names
 * (`Id`, `Doc`, primitives, library types) are printed verbatim; anything we
 * can't faithfully reproduce — recursion, call/index signatures, exotic types —
 * returns `undefined` so the caller keeps the `unknown` fallback. The result is
 * thus never worse than today, only more precise.
 */
const expandUnreachableType = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>): string | undefined => {
    if (depth > MAX_EXPANSION_DEPTH || seen.has(type)) {
        return undefined;
    }

    // Reachable types already print correctly by name — leave them verbatim.
    if (!referencesUnreachableLocalType(type, node, handlerFilePath)) {
        return type.getText(node);
    }

    const nextSeen = new Set(seen).add(type);

    if (type.isArray()) {
        return expandArrayType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    if (type.isUnion()) {
        return expandUnionType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    return expandObjectType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
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
    // wiring to resolve `@lunora/server`/`@lunora/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    if (ANY_TOKEN_RE.test(rendered.replaceAll(STRING_LITERAL_SPAN_RE, ""))) {
        return "unknown";
    }

    // ts-morph renders types relative to the handler's enclosing node, so a
    // locally-declared (non-exported) interface like `interface CursorDoc {…}`
    // inside `cursors.ts` shows up as the bare name `CursorDoc[]` — unreachable
    // from `_generated/api.ts` (TS2304 on compile). Rather than erase to
    // `unknown`, structurally expand it to the real shape; only fall back when
    // the type can't be faithfully reproduced.
    const handlerFilePath = handler.getSourceFile().getFilePath();

    if (referencesUnreachableLocalType(returnType, handler, handlerFilePath)) {
        return expandUnreachableType(returnType, handler, handlerFilePath, 0, new Set<Type>()) ?? "unknown";
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

/** Procedure classification — kind + visibility — produced by {@link classifyProcedureCall}. */
interface ProcedureClassification {
    /** Registration kind: `query` | `mutation` | `action` | `stream`. */
    kind: string;

    /**
     * Set when the call is a connection-lifecycle hook (`onConnect`/`onDisconnect`):
     * the socket side it fires on. The classification is otherwise an internal
     * mutation. Absent for ordinary procedures.
     */
    lifecycle?: "connect" | "disconnect";

    /**
     * Builder-terminal chain root — the expression to the left of the terminal
     * `.query(...)` (`c.use(...)`) — so callers can walk it further (e.g. to find
     * `.use(rls(...))`). Absent for the bare-factory form.
     */
    receiver?: Node;
    visibility: "internal" | "public";
}

/**
 * Classify an `export const x = …` initializer call as a Lunora registration —
 * its kind and visibility — or `undefined` when it isn't one. Handles both the
 * builder terminal (`c.query(...)`, brand-checked via `__lunoraProcedure` so we
 * don't pick up an unrelated method named `query` on some other object) and the
 * bare factory (`query({…})` / `internalQuery({…})`). The single source of truth
 * for "is this a Lunora procedure, and is it internal?" — shared by function
 * discovery here and the RLS-coverage feeder.
 */
const classifyProcedureCall = (call: CallExpression): ProcedureClassification | undefined => {
    const callee = call.getExpression();

    if (Node.isPropertyAccessExpression(callee)) {
        const method = callee.getName();

        if (!FUNCTION_KINDS.has(method)) {
            return undefined;
        }

        const receiver = callee.getExpression();

        // Fast path: the runtime `__lunoraProcedure` brand on the receiver's
        // type. Internal builders also carry `__lunoraVisibility: "internal"`,
        // so its mere presence marks the procedure internal. This works when the
        // project's `@lunora/server` types resolve.
        if (receiver.getType().getProperty("__lunoraProcedure")) {
            return { kind: method, receiver, visibility: receiver.getType().getProperty("__lunoraVisibility") ? "internal" : "public" };
        }

        // Robust fallback: walk the builder chain (`.input()`/`.use()`/`.output()`)
        // to its root identifier and resolve it by import name — exactly as the
        // bare-factory path does. This keeps discovery working when dependency
        // types aren't installed (e.g. a freshly-scaffolded project before
        // `pnpm install`, where the `__lunoraProcedure` brand can't resolve).
        const rootKind = resolveBuilderRootKind(receiver);

        if (rootKind) {
            return { kind: method, receiver, visibility: rootKind };
        }

        return undefined;
    }

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const calleeName = resolveCalleeKind(callee);

    if (!calleeName) {
        return undefined;
    }

    if (FUNCTION_KINDS.has(calleeName)) {
        return { kind: calleeName, visibility: "public" };
    }

    const internalKind = INTERNAL_FACTORIES[calleeName];

    if (internalKind) {
        return { kind: internalKind, visibility: "internal" };
    }

    const lifecycle = LIFECYCLE_FACTORIES[calleeName];

    if (lifecycle) {
        // A lifecycle hook is an internal mutation tagged with its socket side;
        // it lands in LUNORA_FUNCTIONS for path dispatch and in the lifecycle
        // manifest emit derives from the `lifecycle` tag.
        return { kind: "mutation", lifecycle, visibility: "internal" };
    }

    return undefined;
};

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one. */
const inlineHandler = (argument: Node | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/** True when `receiver` is the database accessor: `ctx.db` (property named `db`) or a bare `db`. */
const isDatabaseAccessor = (receiver: Node): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db");

/**
 * The inline handler function of a classified procedure call, or `undefined` when
 * it isn't inspectable. The terminal call's first argument is either the handler
 * function directly (`query(async ({ ctx }) => …)` / `c.use(…).query(handler)`) or
 * an object literal carrying it under a `handler` property (`query({ args, handler })`)
 * — both surface forms are handled. The companion to {@link classifyProcedureCall}:
 * classify the call, then pull out the body to inspect.
 */
const procedureHandler = (initializer: CallExpression): InspectableHandler | undefined => {
    const argument = initializer.getArguments()[0];
    const direct = inlineHandler(argument);

    if (direct !== undefined) {
        return direct;
    }

    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const property = argument.getProperty("handler");

    return property !== undefined && Node.isPropertyAssignment(property) ? inlineHandler(property.getInitializer()) : undefined;
};

/** The simple name of a call's callee — a bare identifier's text or a property access's member name, else `""`. */
const calleeName = (callee: Node): string => {
    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: Node, method: string): boolean => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        if (callee.getName() === method) {
            return true;
        }

        node = callee.getExpression();
    }

    return false;
};

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.&lt;method>(&lt;wrappedCallee>(...))` step — a `.&lt;method>(...)` whose first argument
 * is a call to `wrappedCallee` (e.g. `.use(mask(...))` or `.use(rls(...))`).
 */
const chainUsesWrappedCall = (receiver: Node, method: string, wrappedCallee: string): boolean => {
    let node: Node = receiver;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        const argument = node.getArguments()[0];

        if (
            callee.getName() === method &&
            argument !== undefined &&
            Node.isCallExpression(argument) &&
            calleeName(argument.getExpression()) === wrappedCallee
        ) {
            return true;
        }

        node = callee.getExpression();
    }

    return false;
};

/**
 * Recursively collect `.ts` files under a lunora source directory, skipping
 * `_generated/`, `node_modules/`, and `schema.ts`. Shared by function and
 * migration discovery so both walk the same file set.
 *
 * Uses `lstatSync` (never `statSync`) so symlinked entries are classified by the
 * link itself, not its target: a directory symlink pointing at an ancestor (e.g.
 * `lunora/loop -> ..`) is therefore not descended into, breaking the symlink-cycle
 * infinite-recursion / build-hang that `statSync` (which follows links) would hit.
 */
const listLunoraSourceFiles = (directory: string, accumulator: string[] = [], root: string = directory): string[] => {
    let entries: string[];

    try {
        entries = readdirSync(directory);
    } catch {
        return accumulator;
    }

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = lstatSync(full);

        if (info.isDirectory()) {
            if (entry === "_generated" || entry === "node_modules") {
                continue;
            }

            listLunoraSourceFiles(full, accumulator, root);
        } else if (info.isFile() && extname(entry) === ".ts") {
            // Skip ONLY the top-level `lunora/schema.ts` — it is loaded separately
            // by `discoverSchema`. A nested `lunora/<feature>/schema.ts` is an
            // ordinary source file that can carry query/mutation/migration
            // registrations, so it must be discovered (the `directory === root`
            // guard fires at depth 0 only, where `directory` is the passed root).
            if (entry === "schema.ts" && directory === root) {
                continue;
            }

            accumulator.push(full);
        }
    }

    return accumulator;
};

/**
 * Classify a top-level `export const x = …` initializer call as a Lunora
 * registration, or `undefined` when it isn't one. Handles both the bare-factory
 * form (`query({...})` / `internalQuery({...})`) and the builder terminal
 * (`c.query(...)`).
 */
const discoverFromCall = (call: CallExpression): DiscoveredFunction | undefined => {
    const classified = classifyProcedureCall(call);

    if (!classified) {
        return undefined;
    }

    // Builder terminal: pull args/return type from the chain; bare factory: from the call.
    if (classified.receiver) {
        return {
            args: argsFromBuilderChain(classified.receiver),
            kind: classified.kind,
            returnType: returnTypeFromBuilderCall(call),
            visibility: classified.visibility,
        };
    }

    // Lifecycle hooks (`onConnect`/`onDisconnect`) take a bare handler, not the
    // `{ args, handler }` literal — their args are framework-fixed (empty) and
    // their return is void, so skip the object-literal extraction.
    if (classified.lifecycle) {
        return { args: {}, kind: classified.kind, lifecycle: classified.lifecycle, returnType: "void", visibility: classified.visibility };
    }

    return {
        args: argsFromCall(call),
        kind: classified.kind,
        returnType: returnTypeFromCall(call),
        visibility: classified.visibility,
    };
};

/**
 * Depth bound for {@link resolveExpressionToCall} so an aliased/cyclic reference
 * (`export const a = b; export const b = a`) can't loop forever.
 */
const RE_EXPORT_RESOLVE_LIMIT = 8;

/**
 * Follow a non-call initializer back to the `query/mutation/action({...})` call
 * that produced it, so a **re-exported** registered function is discovered the
 * same as a directly-declared one. This is what makes a plugin/component's
 * `export const { check } = component.functions` (or
 * `export const check = component.functions.check`) emit into the generated
 * `api`, rather than being silently skipped.
 *
 * Resolution hops through ts-morph symbols — identifier → its `const`
 * initializer, property access → the object-literal `PropertyAssignment`,
 * destructured binding → the matching property on the right-hand side — until it
 * reaches a `CallExpression` (then {@link discoverFromCall} classifies it) or
 * runs out of resolvable steps (then it bails to `undefined`, i.e. skip). A
 * reference into a published component whose value lives only in a `.d.ts` (no
 * call literal) bails cleanly — same as before this resolver existed.
 *
 * Guaranteed shapes are the two documented re-export forms —
 * `export const check = component.functions.check` (property access) and
 * `export const { check } = component.functions` (destructure). More indirect
 * relays (e.g. re-bundling into a fresh object first) may not resolve, but they
 * always **fail safe**: the function is skipped, never mis-attributed.
 */
// `resolveExpressionToCall` and `resolveDeclarationToCall` are mutually
// recursive, so one reference is necessarily forward whatever the order — the
// single disable below covers it (the project's `func-style` rule rules out
// hoisted `function` declarations that would otherwise avoid it).
const resolveExpressionToCall = (node: Node, depth = 0): CallExpression | undefined => {
    if (depth > RE_EXPORT_RESOLVE_LIMIT) {
        return undefined;
    }

    if (Node.isCallExpression(node)) {
        return node;
    }

    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
        return resolveExpressionToCall(node.getExpression(), depth + 1);
    }

    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const declaration = node.getSymbol()?.getValueDeclaration();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; resolveDeclarationToCall is defined just below
    return declaration ? resolveDeclarationToCall(declaration, depth + 1) : undefined;
};

/** Continue {@link resolveExpressionToCall} from the declaration a symbol resolved to. */
const resolveDeclarationToCall = (declaration: Node, depth: number): CallExpression | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        const initializer = declaration.getInitializer();

        return initializer ? resolveExpressionToCall(initializer, depth) : undefined;
    }

    if (Node.isShorthandPropertyAssignment(declaration)) {
        // `{ check }` shorthand — resolve the local `check` it refers to.
        return resolveExpressionToCall(declaration.getNameNode(), depth);
    }

    if (Node.isBindingElement(declaration)) {
        // `const { check } = component.functions` — the value comes from the
        // right-hand side's `check` property, not from the binding element.
        const propertyName = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
        const variableDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const rightHandSide = variableDeclaration?.getInitializer();
        const propertyDeclaration = rightHandSide?.getType().getProperty(propertyName)?.getValueDeclaration();

        return propertyDeclaration ? resolveDeclarationToCall(propertyDeclaration, depth + 1) : undefined;
    }

    return undefined;
};

/**
 * Yield the `[exportName, call]` pairs an exported variable declaration
 * contributes. Handles both `export const list = query({...})` (direct, or an
 * identifier/property-access re-export resolved via {@link resolveExpressionToCall})
 * and `export const { check, reset } = component.functions` (one pair per
 * destructured element). Pairs whose call isn't a Lunora registration are
 * filtered out downstream by {@link discoverFromCall}.
 */
const exportCallsOfDeclaration = (declaration: VariableDeclaration): [string, CallExpression][] => {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode)) {
        const pairs: [string, CallExpression][] = [];

        for (const element of nameNode.getElements()) {
            const call = resolveExpressionToCall(element.getNameNode());

            if (call) {
                pairs.push([element.getName(), call]);
            }
        }

        return pairs;
    }

    const initializer = declaration.getInitializer();
    const call = initializer && (Node.isCallExpression(initializer) ? initializer : resolveExpressionToCall(initializer));

    return call ? [[declaration.getName(), call]] : [];
};

/** Build a {@link FunctionIR} entry from one classified registration call, or `undefined` when it isn't a Lunora registration. */
const functionIrFromCall = (call: CallExpression, exportName: string, relativePath: string): FunctionIR | undefined => {
    const discovered = discoverFromCall(call);

    if (!discovered) {
        return undefined;
    }

    return {
        args: discovered.args,
        exportName,
        filePath: relativePath,
        kind: discovered.kind as FunctionIR["kind"],
        returnType: discovered.returnType,
        visibility: discovered.visibility,
        ...(discovered.lifecycle ? { lifecycle: discovered.lifecycle } : {}),
    };
};

/** Lift every Lunora registration in one source file into {@link FunctionIR} entries. */
const discoverFileFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            for (const [exportName, call] of exportCallsOfDeclaration(declaration)) {
                const entry = functionIrFromCall(call, exportName, relativePath);

                if (entry) {
                    found.push(entry);
                }
            }
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
 * Migrations are intentionally NOT considered here: the emitted `LUNORA_MIGRATIONS`
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
                { code: "NAMESPACE_COLLISION", name: "LunoraError", paths: [prior, entry.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, entry.filePath);
    }
};

/**
 * Scan all .ts files under `lunoraDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
const discoverFunctions = (project: Project, lunoraDirectory: string): FunctionIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        functions.push(...discoverFileFunctions(source, relativePath));
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    assertNoNamespaceCollision(functions);

    return functions;
};

export type { InspectableHandler, ProcedureClassification };
export {
    chainHasStep,
    chainUsesWrappedCall,
    classifyProcedureCall,
    discoverFunctions,
    inlineHandler,
    isDatabaseAccessor,
    listLunoraSourceFiles,
    lunoraRelativePath,
    procedureHandler,
    unwrapHandlerReturn,
};
