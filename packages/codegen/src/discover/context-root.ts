/**
 * What denotes a handler's `ctx`, resolved by symbol — the ONE resolver every
 * feeder matches a `ctx.<surface>` receiver and a ctx-scoped value through.
 *
 * The spelling `ctx` (any binding) keeps matching exactly as before; on top of
 * it a handler's positional ctx under any name (`(c, args) => c.db…`, a
 * `defineMutator` `server`, a bare-factory `handler`, method shorthand, a
 * `server: impl` / `handler: impl` declared separately), the `ctx` key of a
 * handler's options object (`({ ctx: c })`, `({ ctx: { db } })`), anything
 * destructured from one (`({ db }, args)`, `const { db } = ctx`), and
 * `const` / unreassigned `let` bindings of these, up to {@link MAX_CONTEXT_HOPS}.
 *
 * Two policies read it. Discovery (`mayDenoteContextDatabase`,
 * `contextSurfaceText`, `isContextIdentifier`) fails toward MATCHING: a `let`
 * alias reassigned later still counts, so its writes are discovered. Trust
 * (`referencesContext`, the ctx-scoped exemption) fails toward REPORTING: a
 * reassigned `let` alias is not server-scoped.
 */
import type {
    ArrowFunction,
    BindingElement,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    Node as TsNode,
    ObjectLiteralElementLike,
    ParameterDeclaration,
    ts,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { bindingKeyName, findObjectProperty, isConstDeclaration, isWriteTarget, unwrapExpression } from "./ast";
import { declarationOf, isTypePosition } from "./attribution";
import { classifyProcedureCall } from "./functions/classify-procedure-call";
import { isDefineMutatorCallee } from "./mutators";

/** How many `const` hops (`const c = ctx; const d = c.db`) a binding is followed through. */
const MAX_CONTEXT_HOPS = 8;

/** A function a handler member can name. */
type HandlerFunction = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

/**
 * The function a `server:` / `handler:` member denotes: an inline arrow or
 * function expression, a method shorthand (`async handler(c, args) {}`), or a
 * same-file `const` / `function` it names (`server: impl`, `{ handler }`).
 */
const memberFunctionOf = (member: ObjectLiteralElementLike | undefined): HandlerFunction | undefined => {
    if (Node.isMethodDeclaration(member)) {
        return member;
    }

    const value = Node.isPropertyAssignment(member) ? unwrapExpression(member.getInitializer()) : undefined;
    const reference = Node.isShorthandPropertyAssignment(member) ? member.getNameNode() : value;

    if (Node.isArrowFunction(reference) || Node.isFunctionExpression(reference)) {
        return reference;
    }

    const declaration = Node.isIdentifier(reference) ? declarationOf(reference) : undefined;

    if (Node.isFunctionDeclaration(declaration)) {
        return declaration;
    }

    const initializer = isConstDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;

    return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer) ? initializer : undefined;
};

/** The positional handlers one registration call declares: a mutator's `server`, a bare factory's `handler`. */
const positionalHandlersOfCall = (call: CallExpression): HandlerFunction[] => {
    const literal = unwrapExpression(call.getArguments()[0]);
    const options = Node.isObjectLiteralExpression(literal) ? literal : undefined;
    const server = findObjectProperty(options, "server");
    const handler = findObjectProperty(options, "handler");
    const isMutator = server !== undefined && isDefineMutatorCallee(call.getExpression());
    const classified = handler === undefined ? undefined : classifyProcedureCall(call);
    const isFactory = classified !== undefined && classified.receiver === undefined;

    return [isMutator ? memberFunctionOf(server) : undefined, isFactory ? memberFunctionOf(handler) : undefined].filter(
        (target): target is HandlerFunction => target !== undefined,
    );
};

/** Per-file {@link positionalHandlersOf} sets, keyed on the compiler node so a re-parse rebuilds them. */
const POSITIONAL_HANDLERS = new WeakMap<ts.SourceFile, ReadonlySet<ts.Node>>();

/**
 * The functions of one file that take the ctx POSITIONALLY: every
 * `defineMutator` `server` impl and every bare-factory registration `handler`
 * (`mutation({ handler: (ctx, args) => … })`), inline, method shorthand, or
 * named. A builder terminal's handler takes the `{ ctx, args }` options object
 * instead, which {@link bindingContextPath} reads by its `ctx` key.
 */
const positionalHandlersOf = (node: TsNode): ReadonlySet<ts.Node> => {
    const sourceFile = node.getSourceFile();
    const cached = POSITIONAL_HANDLERS.get(sourceFile.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const handlers = new Set(
        sourceFile
            .getDescendantsOfKind(SyntaxKind.CallExpression)
            .flatMap((call) => positionalHandlersOfCall(call))
            .map((target) => target.compilerNode),
    );

    POSITIONAL_HANDLERS.set(sourceFile.compilerNode, handlers);

    return handlers;
};

/** Whether `parameter` is a handler's POSITIONAL `ctx`: the first parameter of a {@link positionalHandlersOf} function. */
const isHandlerContextParameter = (parameter: ParameterDeclaration): boolean => {
    const handler = parameter.getParent();

    return (
        (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler) || Node.isFunctionDeclaration(handler) || Node.isMethodDeclaration(handler)) &&
        handler.getParameters()[0] === parameter &&
        positionalHandlersOf(parameter).has(handler.compilerNode)
    );
};

/** Per-binding {@link isRebound} verdicts, keyed on the compiler node. */
const REBOUND_CACHE = new WeakMap<ts.Node, boolean>();

/** Whether a `let` / `var` binding is assigned after its declaration (`db = other`); a `const` never is. */
const isRebound = (binding: BindingElement | VariableDeclaration): boolean => {
    const list = binding.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);
    const nameNode = binding.getNameNode();

    if (list === undefined || isConstDeclaration(list.getDeclarations()[0]) || !Node.isIdentifier(nameNode)) {
        return false;
    }

    let rebound = REBOUND_CACHE.get(binding.compilerNode);

    if (rebound === undefined) {
        const scope =
            binding.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor)) ?? binding.getSourceFile();

        rebound = scope
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .some(
                (identifier) =>
                    identifier.getText() === nameNode.getText() &&
                    isWriteTarget(identifier) &&
                    declarationOf(identifier)?.compilerNode === binding.compilerNode,
            );
        REBOUND_CACHE.set(binding.compilerNode, rebound);
    }

    return rebound;
};

/** The ctx path a ctx-surface expression denotes: `[]` for the ctx itself, `["db"]` for `ctx.db`, `["auth", "userId"]` for `ctx.auth.userId`. */
type ContextPath = ReadonlyArray<string>;

/**
 * Whether a destructured parameter is a `{ ctx, args }` options object rather
 * than a positional ctx: it binds a `ctx` or `args` key, which a ctx does not
 * have. Only its `ctx` key is then the ctx — `args` must never read as a ctx
 * surface.
 */
const isOptionsPattern = (parameter: ParameterDeclaration): boolean =>
    parameter
        .getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .some((element) => element.getParent().getParent() === parameter && ["args", "ctx"].includes(bindingKeyName(element)));

/** How a binding is resolved: `discover` follows a reassigned `let`, `trust` does not. */
type Policy = "discover" | "trust";

/**
 * The {@link ContextPath} a destructured element binds: its key appended to the
 * path of what the pattern destructures — a handler's positional ctx, an
 * enclosing element's path, or a variable's initializer. In a handler's
 * options object only the `ctx` key is the ctx. A rest element binds what is
 * left of an object, not a surface, so it denotes none.
 */
const bindingContextPath = (element: BindingElement, policy: Policy, hops: number): ContextPath | undefined => {
    const holder = element.getParent().getParent();
    const key = bindingKeyName(element);

    if (element.getDotDotDotToken() !== undefined || (policy === "trust" && isRebound(element))) {
        return undefined;
    }

    let base: ContextPath | undefined;

    if (Node.isParameterDeclaration(holder)) {
        if (!isHandlerContextParameter(holder) || isOptionsPattern(holder)) {
            return key === "ctx" ? [] : undefined;
        }

        base = [];
    } else if (Node.isBindingElement(holder)) {
        base = bindingContextPath(holder, policy, hops);
    } else if (Node.isVariableDeclaration(holder) && hops > 0) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the element and expression resolvers recurse into each other
        base = contextPathOf(holder.getInitializer(), policy, hops - 1);
    }

    return base === undefined ? undefined : [...base, key];
};

/** The member a `<x>.k` / `<x>["k"]` access reads, and the expression it reads it off; `undefined` for anything else. */
const memberAccessOf = (node: TsNode | undefined): { member: string; object: TsNode } | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return { member: node.getName(), object: node.getExpression() };
    }

    const key = Node.isElementAccessExpression(node) ? node.getArgumentExpression() : undefined;

    return Node.isElementAccessExpression(node) && Node.isStringLiteral(key) ? { member: key.getLiteralValue(), object: node.getExpression() } : undefined;
};

/** The {@link ContextPath} `node` denotes under `policy`, or `undefined` when it is no ctx surface. */
const contextPathOf = (node: TsNode | undefined, policy: Policy = "discover", hops = MAX_CONTEXT_HOPS): ContextPath | undefined => {
    const value = unwrapExpression(node);
    const access = memberAccessOf(value);

    if (access !== undefined) {
        const base = contextPathOf(access.object, policy, hops);

        return base === undefined ? undefined : [...base, access.member];
    }

    if (!Node.isIdentifier(value)) {
        return undefined;
    }

    if (value.getText() === "ctx") {
        return [];
    }

    const declaration = declarationOf(value);

    if (Node.isParameterDeclaration(declaration)) {
        return Node.isIdentifier(declaration.getNameNode()) && isHandlerContextParameter(declaration) ? [] : undefined;
    }

    if (Node.isBindingElement(declaration)) {
        return bindingContextPath(declaration, policy, hops);
    }

    const isFollowed = Node.isVariableDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) && hops > 0;

    if (!isFollowed || (policy === "trust" && isRebound(declaration))) {
        return undefined;
    }

    return contextPathOf(declaration.getInitializer(), policy, hops - 1);
};

/** The `ctx.<a>.<b>` spelling of the ctx surface `node` denotes (`c.kv` → `ctx.kv`), or `undefined`. */
const contextSurfaceText = (node: TsNode): string | undefined => {
    const path = contextPathOf(node);

    return path === undefined ? undefined : ["ctx", ...path].join(".");
};

/**
 * Whether a receiver's text matches `accept`, as written or as the ctx surface
 * it denotes: `ctx.kv` matches `"ctx.kv"` as before, and so do `c.kv`, a
 * destructured `kv` and `const store = ctx.kv`.
 */
const matchesContextReceiver = (receiver: TsNode, accept: (text: string) => boolean): boolean => {
    if (accept(receiver.getText())) {
        return true;
    }

    const surface = contextSurfaceText(receiver);

    return surface !== undefined && accept(surface);
};

/** Whether `node` denotes exactly the ctx surface `path` (`isContextSurface(c.ai, ["ai"])`, a destructured `ai` too). */
const isContextSurface = (node: TsNode | undefined, path: ReadonlyArray<string>): boolean => {
    const value = unwrapExpression(node);

    const access = memberAccessOf(value);

    // Cheap reject before any symbol lookup: a member access must name the path's last member.
    if (access !== undefined && access.member !== path.at(-1)) {
        return false;
    }

    const denoted = value === undefined ? undefined : contextPathOf(value);

    return denoted?.length === path.length && denoted.every((segment, index) => segment === path[index]);
};

/**
 * The nodes inside `scope` that denote the ctx surface `ctx.<property>`, in
 * source order: every `<ctx>.<property>` access on a {@link isContextIdentifier}
 * receiver (`ctx.flags`, a renamed `c.flags`), and every value reference to a
 * binding DESTRUCTURED as that surface (`const { flags } = ctx`,
 * `({ ctx: { flags } })`). A `const` bound to `ctx.flags` is not listed again:
 * its initializer already is.
 */
const contextSurfaceNodesIn = (scope: TsNode, property: string): ReadonlyArray<TsNode> =>
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the per-scope index is declared just below
    contextSurfacesIn(scope).get(property) ?? [];

/** The `[member, value reference]` pairs of the bindings `scope` destructures as one ctx surface (`const { flags } = ctx` → `flags` uses). */
const destructuredSurfacesIn = (scope: TsNode): [string, TsNode][] => {
    const surfaceByElement = new Map<ts.Node, string>();

    for (const element of scope.getDescendantsOfKind(SyntaxKind.BindingElement)) {
        const path = Node.isIdentifier(element.getNameNode()) ? bindingContextPath(element, "discover", MAX_CONTEXT_HOPS) : undefined;

        if (path?.length === 1 && path[0] !== undefined) {
            surfaceByElement.set(element.compilerNode, path[0]);
        }
    }

    const spellings = new Set([...surfaceByElement.keys()].map((node) => (node as ts.BindingElement).name.getText()));

    return scope.getDescendantsOfKind(SyntaxKind.Identifier).flatMap((identifier): [string, TsNode][] => {
        const isCandidate = spellings.has(identifier.getText()) && !Node.isBindingElement(identifier.getParent());
        const declaration = isCandidate ? declarationOf(identifier) : undefined;
        const member = declaration === undefined ? undefined : surfaceByElement.get(declaration.compilerNode);

        return member === undefined ? [] : [[member, identifier]];
    });
};

/** Per-scope {@link contextSurfacesIn} indexes, keyed on the compiler node. */
const SURFACES_CACHE = new WeakMap<ts.Node, ReadonlyMap<string, ReadonlyArray<TsNode>>>();

/**
 * Every ctx surface node inside `scope`, grouped by the surface member it
 * denotes — ONE pass for all members: the `<ctx>.<member>` accesses, and the
 * value references to bindings destructured as `ctx.<member>` (found by
 * resolving each destructured element of the scope once, then only the
 * identifiers spelled like one).
 */
const contextSurfacesIn = (scope: TsNode): ReadonlyMap<string, ReadonlyArray<TsNode>> => {
    const cached = SURFACES_CACHE.get(scope.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const found = new Map<string, TsNode[]>();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- declared just below, beside its siblings
    for (const [member, node] of [...contextMemberAccessesIn(scope), ...destructuredSurfacesIn(scope)]) {
        found.set(member, [...(found.get(member) ?? []), node]);
    }

    const index = new Map([...found].map(([member, nodes]) => [member, nodes.toSorted((left, right) => left.getPos() - right.getPos())] as const));

    SURFACES_CACHE.set(scope.compilerNode, index);

    return index;
};

/** The `[member, access]` pairs of every `<ctx>.<member>` access in `scope`. */
const contextMemberAccessesIn = (scope: TsNode): [string, TsNode][] =>
    scope
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- declared just below, beside its siblings
        .flatMap((access): [string, TsNode][] => (isContextIdentifier(access.getExpression()) ? [[access.getName(), access]] : []));

/** Whether `node` denotes the handler's ctx object itself (the `ctx` of `ctx.flags`, `ctx.fetch`). */
const isContextIdentifier = (node: TsNode): boolean => Node.isIdentifier(node) && contextPathOf(node)?.length === 0;

/** Whether `node` denotes a handler's `ctx.db` (discovery policy). */
const mayDenoteContextDatabase = (node: TsNode | undefined): boolean => {
    const path = contextPathOf(node);

    return path?.length === 1 && path[0] === "db";
};

/**
 * True when `receiver` is the database accessor: anything named `db` by
 * shape (`ctx.db`, `this.db`, a bare `db`, as every feeder has always matched
 * it), or a binding resolving to `ctx.db` under another name
 * (`const database = ctx.db`).
 */
const isDatabaseAccessor = (receiver: TsNode): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") ||
    (Node.isIdentifier(receiver) && receiver.getText() === "db") ||
    mayDenoteContextDatabase(receiver);

/** Whether `identifier` names a value, not a property: the `k` of `x.k` and of `{ k: v }` names a property. */
const isValueIdentifier = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    return !(
        (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) ||
        (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) ||
        isTypePosition(identifier)
    );
};

/**
 * Whether `node` references a server-trusted ctx value by symbol (trust
 * policy): it is, or contains, a value identifier that denotes the ctx or a
 * surface of it — `ctx.auth.userId`, `c.auth.userId`, a destructured `auth`,
 * `const userId = ctx.auth.userId`. A reassigned `let` alias does not count.
 */
const referencesContext = (node: TsNode): boolean => {
    const identifiers = Node.isIdentifier(node) ? [node] : node.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some((identifier) => isValueIdentifier(identifier) && contextPathOf(identifier, "trust") !== undefined);
};

/**
 * List reads whose options object the `ctx.db` read feeders inspect. Only
 * `findMany` / `findFirst` / `findFirstOrThrow` / `findUnique` take an options
 * object — the by-id `get` is id-only and the fluent `query(...)` reader carries
 * no options object, so both are excluded.
 *
 * A read method missing from this set is INVISIBLE to every feeder that reads
 * through `readTargetOf` — the soft-delete and relation-load analyses — so adding
 * one to the facade means adding it here in the same change.
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "findUnique"]);

/**
 * The `(table, options)` a `ctx.db` list read addresses, or `undefined` when the
 * call isn't one. Matched by receiver **shape** (not import origin), fail-closed,
 * in both surface forms Lunora exposes. Facade form
 * `ctx.db.<table>.findMany(options?)` — the form real app code writes — puts the
 * table in the receiver's property name and the options object at argument 0.
 * Table-arg form `ctx.db.findMany("table", options?)` puts the table in the
 * string-literal argument 0 and the options object at argument 1. `table` is `""`
 * when the table-arg form's first argument isn't a string literal (a dynamic
 * table — not lintable).
 */
const readTargetOf = (call: CallExpression): { options: TsNode | undefined; table: string } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !READ_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    // Table-arg form: the receiver is `ctx.db` (property named `db`) or a bare `db`.
    if (isDatabaseAccessor(receiver)) {
        const first = call.getArguments()[0];

        return { options: call.getArguments()[1], table: first && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = isDatabaseAccessor(inner);

        if (onDatabase) {
            return { options: call.getArguments()[0], table: receiver.getName() };
        }
    }

    return undefined;
};

/** True when `call` is a `ctx.db.<method>(...)` or bare `db.<method>(...)` call against `methodSet`. */
const isDatabaseCall = (call: CallExpression, methodSet: ReadonlySet<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    return isDatabaseAccessor(callee.getExpression());
};

/** String-literal first argument of a `ctx.db.<method>("table", ...)` call, or `""` when the argument is not a string literal (dynamic table — not lintable). */
const tableArgumentOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover the set of tables read and written inside the lexical scope of the
 * exported procedure binding (including helper closures in the body), against
 * the caller's read/write method sets.
 */
const tablesAccessedIn = (
    declaration: TsNode,
    readMethods: ReadonlySet<string>,
    writeMethods: ReadonlySet<string>,
): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDatabaseCall(call, readMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDatabaseCall(call, writeMethods)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

export {
    contextPathOf,
    contextSurfaceNodesIn,
    contextSurfaceText,
    isContextIdentifier,
    isContextSurface,
    isDatabaseAccessor,
    isDatabaseCall,
    isHandlerContextParameter,
    matchesContextReceiver,
    mayDenoteContextDatabase,
    readTargetOf,
    referencesContext,
    tableArgumentOf,
    tablesAccessedIn,
};
export type { ContextPath };
