import type {
    ArrowFunction,
    BindingElement,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    Node as TsNode,
    ObjectLiteralExpression,
    ParameterDeclaration,
    Project,
    ts,
    Type,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { CallSiteScope, FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../ir";
import { bindingKeyName, collectCallRows, isConstDeclaration, isWriteTarget, outermostValueWrapper, propertyKeyName, unwrapExpression } from "./ast";
import { callSiteScopeOf, declarationOf, withCallerVisibility } from "./attribution";
import isContextDatabase from "./context-binding";
import type { MutatorServerImpl } from "./mutators";
import { mutatorServerImplOf } from "./mutators";

/**
 * Ownership / identity columns whose value must come from the server-trusted
 * identity (`ctx.auth` / `ctx.identity`), never from request input. Writing one
 * of these from `args` lets a caller act as another user or tenant — a
 * cross-tenant IDOR. Kept deliberately tight to identity / tenancy columns (not
 * arbitrary foreign keys the caller may legitimately choose) to hold the
 * false-positive rate down; the members are the identity-ish columns that
 * actually appear in the repo's example schemas.
 */
const IDENTITY_FIELDS = new Set<string>([
    "accountId",
    "authorId",
    "createdBy",
    "createdById",
    "organizationId",
    "orgId",
    "ownerId",
    "tenantId",
    "updatedBy",
    "userId",
    "workspaceId",
]);

/**
 * `ctx.db` write surfaces whose document / partial (the object whose identity
 * columns this feeder inspects) is the SECOND argument: `insert(table, doc)`,
 * `replace(id, doc)`, `patch(id, partial)`, and `insertManyUnsafe(table, rows)`
 * (`rows` an array of documents). The document argument is always `arg[1]`.
 */
const IDENTITY_WRITE_METHODS = new Set<string>(["insert", "insertManyUnsafe", "patch", "replace"]);

/**
 * When `node` is a `<ctx>.db.<method>` member access for one of the
 * {@link IDENTITY_WRITE_METHODS}, return the method name; otherwise `undefined`.
 * The `ctx.db` receiver is resolved by symbol (see `isContextDatabase`), so a
 * renamed (`(c, args) => c.db.insert(…)`) or destructured
 * (`({ db }, args) => db.insert(…)`, `const { db } = ctx`) ctx still matches.
 */
const contextDatabaseWriteMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    return IDENTITY_WRITE_METHODS.has(method) && isContextDatabase(node.getExpression()) ? method : undefined;
};

/**
 * The object literals whose identity columns a write's document argument
 * contributes: the argument itself for the single-document writes, and each
 * array element for `insertManyUnsafe`'s row list.
 */
const documentObjectLiterals = (documentArgument: TsNode, method: string): ObjectLiteralExpression[] => {
    if (method !== "insertManyUnsafe") {
        return Node.isObjectLiteralExpression(documentArgument) ? [documentArgument] : [];
    }

    if (!Node.isArrayLiteralExpression(documentArgument)) {
        return [];
    }

    const objectLiterals: ObjectLiteralExpression[] = [];

    for (const element of documentArgument.getElements()) {
        if (Node.isObjectLiteralExpression(element)) {
            objectLiterals.push(element);
        }
    }

    return objectLiterals;
};

/**
 * The mutator `server` impl `call` runs in, plus its own `ctx` and `args`
 * parameters. `pristine` says whether `args` is still exactly the object
 * `applyOwnerScope` verified (see {@link isPristineArgsParameter}).
 */
interface MutatorImplScope {
    context: ParameterDeclaration | undefined;
    impl: MutatorServerImpl;
    parameter: ParameterDeclaration | undefined;
    pristine: boolean;
}

/** Per-impl {@link isPristineArgsParameter} verdicts, keyed on the compiler node so a re-parse recomputes. */
const PRISTINE_CACHE = new WeakMap<ts.Node, boolean>();

/**
 * `ctx` methods whose result echoes caller-chosen input: `ctx.db.asId(table, args.x)`
 * returns that very id, and a `ctx.run*` result can hand its args straight
 * back. A chain through one of these is not server-scoped; its taint is that
 * of its arguments.
 */
const ECHOING_CONTEXT_METHODS = new Set<string>(["asId", "runAction", "runMutation", "runQuery"]);

/**
 * Methods whose RESULT is built from their callback's return value (or a seed
 * argument): a ctx-rooted receiver does not make that result server-scoped.
 */
const CALLBACK_RESULT_METHODS = new Set<string>(["catch", "flatMap", "map", "reduce", "reduceRight", "then"]);

/**
 * Methods whose result is their receiver, one of its elements, or a value
 * derived from it without the callback's return value (an index, a boolean):
 * array narrowing and the `ctx.db` query builder. Their callbacks
 * (`withIndex((q) => q.eq("orgId", args.orgId))`) only select.
 */
const RECEIVER_RESULT_METHODS = new Set<string>([
    "at",
    "every",
    "filter",
    "finally",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "order",
    "slice",
    "some",
    "sort",
    "withIndex",
    "withSearchIndex",
]);

/**
 * The values an inline callback can return: an expression body, or every
 * `return` of a block body (a bare `return;` as `undefined`). `undefined` when
 * `node` is not an inline arrow / function expression.
 */
const callbackResults = (node: TsNode): (TsNode | undefined)[] | undefined => {
    const callback = unwrapExpression(node);

    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) {
        return undefined;
    }

    const body = callback.getBody();

    if (!Node.isBlock(body)) {
        return [body];
    }

    return body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) === callback)
        .map((statement) => statement.getExpression());
};

/**
 * Whether `node` may name a function: an identifier bound to a function
 * declaration or to a variable initialized with a function, or one this cannot
 * resolve. A callback passed by reference is not read, so it fails closed.
 */
const isFunctionReference = (node: TsNode): boolean => {
    const value = unwrapExpression(node);

    if (!Node.isIdentifier(value)) {
        return Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value);
    }

    const declaration = declarationOf(value);
    const initializer = Node.isVariableDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;

    return (
        declaration === undefined ||
        Node.isFunctionDeclaration(declaration) ||
        Node.isParameterDeclaration(declaration) ||
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)
    );
};

/** `Promise` combinators whose result is the settled values of their argument's elements. */
const PROMISE_COMBINATORS = new Set<string>(["all", "allSettled", "any", "race"]);

/**
 * The leftmost operand of `value`'s member / call chain: walked through
 * property and element access, the callee side of calls, `await`, parentheses
 * and casts (`(await ctx.db.get(id)).owner` → `ctx`).
 */
const chainRootOf = (value: TsNode): TsNode | undefined => {
    let current: TsNode | undefined = unwrapExpression(value);

    while (
        Node.isAwaitExpression(current) ||
        Node.isPropertyAccessExpression(current) ||
        Node.isElementAccessExpression(current) ||
        Node.isCallExpression(current)
    ) {
        current = unwrapExpression(current.getExpression());
    }

    return current;
};

/** Whether `node` resolves, by symbol, to the impl's `ctx` parameter or to a binding destructured out of it (`{ db }`). */
const isContextReference = (node: TsNode | undefined, context: ParameterDeclaration | undefined): boolean => {
    const declaration = Node.isIdentifier(node) && context !== undefined ? declarationOf(node) : undefined;

    if (declaration === undefined || context === undefined) {
        return false;
    }

    if (declaration.compilerNode === context.compilerNode) {
        return Node.isIdentifier(context.getNameNode());
    }

    return Node.isBindingElement(declaration) && declaration.getFirstAncestorByKind(SyntaxKind.Parameter)?.compilerNode === context.compilerNode;
};

/** Whether `node` is the operand of a plain member READ: `x.k`, `x?.k`, `x[k]`, seen through wrappers, and not written. */
const isMemberRead = (node: TsNode): boolean => {
    const value = outermostValueWrapper(node);
    const access = value.getParent();

    return (Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) && access.getExpression() === value && !isWriteTarget(access);
};

/** Whether `node` is the initializer of a destructuring declaration (`const { a } = node`), which only reads members. */
const isDestructuringRead = (node: TsNode): boolean => {
    // With a binding-pattern name, the only expression child a declaration has is its initializer.
    const declaration = outermostValueWrapper(node).getParent();

    return Node.isVariableDeclaration(declaration) && Node.isObjectBindingPattern(declaration.getNameNode());
};

/**
 * Whether `node` is only COPIED: spread into a new object / array literal
 * (`{ ...args }`, `[...list]`), or interpolated into an untagged template
 * (`${args}`). A tagged template hands the raw value to its tag, so it is not.
 */
const isCopiedOnly = (node: TsNode): boolean => {
    const value = outermostValueWrapper(node);
    const parent = value.getParent();

    if (Node.isSpreadAssignment(parent) || Node.isSpreadElement(parent)) {
        const literal = parent.getParent();

        return (Node.isObjectLiteralExpression(literal) || Node.isArrayLiteralExpression(literal)) && !isWriteTarget(literal);
    }

    return Node.isTemplateSpan(parent) && !Node.isTaggedTemplateExpression(parent.getParent().getParent());
};

/** A TypeScript standard-library declaration file (`…/typescript/lib/lib.es2015.d.ts`). */
const TYPESCRIPT_LIB_FILE = /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u;

/**
 * Whether `identifier` is the platform global it is spelled as: it resolves to
 * no declaration, or only to one in a library `.d.ts` (TypeScript's `lib.*`,
 * `@types/node`). A local `const JSON = { stringify: (a) => … }` does not.
 */
const isLibraryGlobal = (identifier: Identifier): boolean => {
    const declaration = declarationOf(identifier);

    if (declaration === undefined) {
        return true;
    }

    const sourceFile = declaration.getSourceFile();
    const path = sourceFile.getFilePath();

    return sourceFile.isDeclarationFile() && (TYPESCRIPT_LIB_FILE.test(path) || path.includes("/@types/node/"));
};

/**
 * Whether `node` is an argument of a call that only reads, serializes or copies
 * it: `console.*`, `JSON.stringify`, `structuredClone`, any argument of
 * `Object.keys` / `values` / `entries` / `freeze` / `isFrozen`, a non-first
 * argument of `Object.assign`, or any argument of a call on the
 * impl's own `ctx` (`ctx.scheduler.runAfter(0, fn, args)`), the trusted
 * runtime surface. Any other call (`assertValid(args)`, `fix(args)`,
 * `Object.assign(args, …)`, `Reflect.set(args, …)`) may change it.
 */
const isReadOnlyCallArgument = (node: TsNode, context: ParameterDeclaration | undefined): boolean => {
    const value = outermostValueWrapper(node);
    const call = value.getParent();

    if (!Node.isCallExpression(call)) {
        return false;
    }

    const position = call.getArguments().indexOf(value);
    const callee = unwrapExpression(call.getExpression());

    if (position === -1 || callee === undefined) {
        return false;
    }

    if (Node.isIdentifier(callee)) {
        return callee.getText() === "structuredClone" && isLibraryGlobal(callee);
    }

    if (isContextReference(chainRootOf(callee), context)) {
        // An echoing method may hand `args` straight back; only a discarded result keeps it unaliased.
        const isEchoing = Node.isPropertyAccessExpression(callee) && ECHOING_CONTEXT_METHODS.has(callee.getName());

        return (
            !isEchoing ||
            Node.isExpressionStatement(outermostValueWrapper(Node.isAwaitExpression(call.getParent()) ? call.getParentOrThrow() : call).getParent())
        );
    }

    if (!Node.isPropertyAccessExpression(callee)) {
        return false;
    }

    const root = callee.getExpression();

    if (!Node.isIdentifier(root) || !isLibraryGlobal(root)) {
        return false;
    }

    const namespace = root.getText();
    const method = callee.getName();

    switch (namespace) {
        case "console": {
            return true;
        }
        case "JSON": {
            return method === "stringify";
        }
        case "Object": {
            // Only `assign` writes, and only into its first argument; freezing cannot change a member.
            return ["entries", "freeze", "isFrozen", "keys", "values"].includes(method) || (method === "assign" && position > 0);
        }
        default: {
            return false;
        }
    }
};

/** A function whose body this analysis reads: see {@link visibleFunctionOf}. */
type VisibleFunction = ArrowFunction | FunctionDeclaration | FunctionExpression;

/** Per-declaration verdicts of {@link isReassignedFunction}, keyed on the compiler node so a re-parse recomputes. */
const REASSIGNED_FUNCTION_CACHE = new WeakMap<ts.Node, boolean>();

/** Whether the binding a `function` declaration creates is ever assigned to (`save = other`): then a call by name may run anything. */
const isReassignedFunction = (declaration: FunctionDeclaration): boolean => {
    const cached = REASSIGNED_FUNCTION_CACHE.get(declaration.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const name = declaration.getName();
    const reassigned = declaration
        .getSourceFile()
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some(
            (identifier) => identifier.getText() === name && isWriteTarget(identifier) && declarationOf(identifier)?.compilerNode === declaration.compilerNode,
        );

    REASSIGNED_FUNCTION_CACHE.set(declaration.compilerNode, reassigned);

    return reassigned;
};

/**
 * The function `callee` runs when this analysis can read its body: an inline
 * arrow / function expression (an IIFE), or an identifier bound IN THE SAME
 * FILE to a `function` declaration (with a body, declared once, never
 * reassigned) or to a `const` initialized with an arrow / function expression.
 * Anything else — an import, a parameter, a `let`, a method — is `undefined`.
 */
const visibleFunctionOf = (callee: TsNode): VisibleFunction | undefined => {
    const value = unwrapExpression(callee);

    if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) {
        return value;
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    if (declaration?.getSourceFile() !== callee.getSourceFile()) {
        return undefined;
    }

    if (Node.isFunctionDeclaration(declaration)) {
        const isSingle = (declaration.getSymbol()?.getDeclarations().length ?? 0) === 1;

        return declaration.hasBody() && isSingle && !isReassignedFunction(declaration) ? declaration : undefined;
    }

    const initializer = isConstDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;

    return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer) ? initializer : undefined;
};

/**
 * The parameter of `target` that receives `argument` of `call`. `null` when
 * no parameter does, so `target` cannot see it; `undefined` when that cannot be told:
 * a spread argument at or before it, a rest parameter, or `arguments` read
 * anywhere in `target`.
 */
const receivingParameter = (target: VisibleFunction, call: CallExpression, argument: TsNode): ParameterDeclaration | null | undefined => {
    const callArguments = call.getArguments();
    const position = callArguments.indexOf(argument);
    const isOpaque =
        position === -1 ||
        callArguments.slice(0, position + 1).some((candidate) => Node.isSpreadElement(candidate)) ||
        target.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => identifier.getText() === "arguments");

    if (isOpaque) {
        return undefined;
    }

    const parameters = target.getParameters();
    const parameter = parameters[position];

    if (parameter === undefined) {
        // eslint-disable-next-line unicorn/no-null -- `null` (no receiver) and `undefined` (unknown) are distinct verdicts
        return parameters.some((candidate) => candidate.isRestParameter()) ? undefined : null;
    }

    return parameter.isRestParameter() ? undefined : parameter;
};

/**
 * The parameter of a {@link visibleFunctionOf} function that `node` is handed to
 * as a call argument (`validate(args)`), `null` when the function takes no
 * parameter there, and `undefined` when `node` is no call argument or the callee
 * cannot be read.
 */
const visibleArgumentTarget = (node: TsNode): ParameterDeclaration | null | undefined => {
    const value = outermostValueWrapper(node);
    const call = value.getParent();

    if (!Node.isCallExpression(call) || call.getExpression() === value) {
        return undefined;
    }

    const target = visibleFunctionOf(call.getExpression());

    return target === undefined ? undefined : receivingParameter(target, call, value);
};

/** How many nested {@link isReadOnlyParameter} hand-offs (`validate` → `check` → …) are followed before failing closed. */
const MAX_READ_ONLY_DEPTH = 4;

/**
 * Whether the function `parameter` belongs to only READS what it is handed
 * there: every use of the parameter is a member read, a destructuring
 * initializer, a copy ({@link isCopiedOnly}), a read-only call argument
 * ({@link isReadOnlyCallArgument}), or an argument to another visible function
 * that is read-only for it, up to {@link MAX_READ_ONLY_DEPTH} hand-offs. Never
 * written through, returned, stored or aliased, and never passed to a function
 * this cannot read. A destructured parameter only copies members out, so it is
 * read-only; a rest parameter never reaches here ({@link receivingParameter}).
 */
const isReadOnlyParameter = (parameter: ParameterDeclaration, depth = 0): boolean => {
    const name = parameter.getNameNode();

    if (!Node.isIdentifier(name)) {
        return true;
    }

    if (depth > MAX_READ_ONLY_DEPTH) {
        return false;
    }

    const isReadOnlyUse = (reference: TsNode): boolean => {
        if (isMemberRead(reference) || isDestructuringRead(reference) || isCopiedOnly(reference) || isReadOnlyCallArgument(reference, undefined)) {
            return true;
        }

        const target = visibleArgumentTarget(reference);

        return target === null || (target !== undefined && isReadOnlyParameter(target, depth + 1));
    };

    return parameter
        .getParentOrThrow()
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .every(
            (identifier) =>
                identifier === name ||
                identifier.getText() !== name.getText() ||
                declarationOf(identifier)?.compilerNode !== parameter.compilerNode ||
                isReadOnlyUse(identifier),
        );
};

/** Whether `node` is `other`: the same compiler node. */
const isSameNode = (node: TsNode | undefined, other: TsNode): boolean => node?.compilerNode === other.compilerNode;

/** The identifier-named `const` that `node` (through wrappers) is the whole initializer of: `const alias = row`. */
const constAliasOf = (node: TsNode): VariableDeclaration | undefined => {
    const value = outermostValueWrapper(node);
    const declaration = value.getParent();

    return isConstDeclaration(declaration) && isSameNode(declaration.getInitializer(), value) && Node.isIdentifier(declaration.getNameNode())
        ? declaration
        : undefined;
};

/** The identifier-named loop variable of a `for…of` that iterates `node`: each element it binds is an element of `node`. */
const forOfVariableOf = (node: TsNode): VariableDeclaration | undefined => {
    const value = outermostValueWrapper(node);
    const loop = value.getParent();
    const initializer = Node.isForOfStatement(loop) && loop.getExpression() === value ? loop.getInitializer() : undefined;
    const [variable] = Node.isVariableDeclarationList(initializer) ? initializer.getDeclarations() : [];

    return variable !== undefined && Node.isIdentifier(variable.getNameNode()) ? variable : undefined;
};

/** Whether every value of `type` is a primitive, which no call can change in place. `any` / `unknown` are not. */
const isPrimitiveType = (type: Type): boolean => {
    if (type.isUnion()) {
        return type.getUnionTypes().every((member) => isPrimitiveType(member));
    }

    if (type.isIntersection()) {
        return type.getIntersectionTypes().some((member) => isPrimitiveType(member));
    }

    return !type.isAny() && !type.isUnknown() && !type.isObject() && !type.isTypeParameter();
};

/** Whether `call` is `Object.assign(<node>, …)` on the platform `Object`: it writes into `node` only what its other arguments carry. */
const isObjectAssignTarget = (call: CallExpression, node: TsNode): boolean => {
    const callee = unwrapExpression(call.getExpression());
    const root = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;

    return (
        Node.isPropertyAccessExpression(callee) &&
        callee.getName() === "assign" &&
        Node.isIdentifier(root) &&
        root.getText() === "Object" &&
        isLibraryGlobal(root) &&
        call.getArguments()[0] === node
    );
};

/**
 * Whether the impl can reach its own body again with an `args` that never went
 * through `applyOwnerScope`. Fails closed on any of:
 *
 * - a named function-expression impl referencing its own name (`impl(ctx, forged)`
 * calls the raw function);
 * - a method or function-expression impl using `this` anywhere (an arrow impl has
 * no `this` of its own);
 * - the impl referencing the mutator binding it is declared in
 * (`createPost.server(ctx, forged)`), by symbol.
 *
 * The runtime wraps the exposed `server` in the same validation and owner scope
 * as `handler` and calls the raw impl with that wrapper as `this`, so the last
 * two are defense in depth.
 */
const canReenterUnverified = (impl: MutatorServerImpl, mutatorDeclaration: VariableDeclaration): boolean => {
    const ownName = Node.isFunctionExpression(impl) ? impl.getNameNode() : undefined;

    if (!Node.isArrowFunction(impl) && impl.getFirstDescendantByKind(SyntaxKind.ThisKeyword) !== undefined) {
        return true;
    }

    const names = new Set([mutatorDeclaration.getName(), ...(ownName === undefined ? [] : [ownName.getText()])]);

    return impl.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => {
        if (identifier === ownName || !names.has(identifier.getText())) {
            return false;
        }

        const target = declarationOf(identifier)?.compilerNode;

        return target !== undefined && (target === mutatorDeclaration.compilerNode || (ownName !== undefined && target === impl.compilerNode));
    });
};

/**
 * Whether the impl's `args` parameter is still exactly the object
 * `applyOwnerScope` verified, for every read of it in the impl. Fails closed:
 *
 * - the impl can re-enter itself unverified (see {@link canReenterUnverified});
 * - `arguments` anywhere in the impl reaches the parameter without naming it;
 * - a `var` redeclaration of a parameter binding is a second declaration of it;
 * - an `args` parameter used as anything but a member read, a destructuring
 * initializer, a copy ({@link isCopiedOnly}), a read-only call argument
 * ({@link isReadOnlyCallArgument}), or an argument to a function declared in
 * this file that only reads it ({@link isReadOnlyParameter}, e.g. a local
 * `assertValid(args)`): written through, passed to another call (`fix(args)`,
 * an imported validator, `Object.assign(args, …)`), or aliased
 * (`const a = args`), it may be changed where this cannot see;
 * - a destructured binding of the parameter that is written (`userId = …`).
 */
const isPristineArgsParameter = (
    scope: Omit<MutatorImplScope, "pristine">,
    parameter: ParameterDeclaration,
    mutatorDeclaration: VariableDeclaration,
): boolean => {
    const { context, impl } = scope;
    const cached = PRISTINE_CACHE.get(impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const nameNode = parameter.getNameNode();
    const bindings = Node.isIdentifier(nameNode)
        ? [nameNode]
        : nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((element) => {
              const name = element.getNameNode();

              return Node.isIdentifier(name) ? [name] : [];
          });
    const declarationByName = new Map(bindings.map((binding) => [binding.getText(), binding.getParentOrThrow().compilerNode]));
    const isAllowedUse = (reference: TsNode): boolean => {
        if (!Node.isIdentifier(nameNode)) {
            return !isWriteTarget(reference);
        }

        if (isMemberRead(reference) || isDestructuringRead(reference) || isCopiedOnly(reference) || isReadOnlyCallArgument(reference, context)) {
            return true;
        }

        // A validator this can read (`assertValid(args)` declared in this file) that only reads it.
        const target = visibleArgumentTarget(reference);

        return target === null || (target !== undefined && isReadOnlyParameter(target));
    };
    const pristine =
        !canReenterUnverified(impl, mutatorDeclaration) &&
        bindings.every((binding) => (binding.getSymbol()?.getDeclarations().length ?? 0) === 1) &&
        impl.getDescendantsOfKind(SyntaxKind.Identifier).every((identifier) => {
            const name = identifier.getText();

            if (name === "arguments") {
                return false;
            }

            const binding = declarationByName.get(name);

            if (binding === undefined || bindings.includes(identifier) || declarationOf(identifier)?.compilerNode !== binding) {
                return true;
            }

            return isAllowedUse(identifier);
        });

    PRISTINE_CACHE.set(impl.compilerNode, pristine);

    return pristine;
};

/**
 * The {@link MutatorImplScope} of `call`, resolved DOWN from the top-level
 * declaration `call` sits in to that declaration's own `server` impl (see
 * {@link mutatorServerImplOf}); `undefined` when the call is not inside it.
 * Never matched by name on an ancestor: a nested `const save = defineMutator(…)`
 * inside the exported `save` resolves to the export's impl, in which the nested
 * mutator's `args` is just a nested function's parameter.
 */
const mutatorImplScopeOf = (call: CallExpression): MutatorImplScope | undefined => {
    const statement = call.getAncestors().at(-2);
    const declaration = Node.isVariableStatement(statement)
        ? statement.getDeclarations().find((candidate) => candidate.getPos() <= call.getPos() && call.getEnd() <= candidate.getEnd())
        : undefined;
    const impl = declaration === undefined ? undefined : mutatorServerImplOf(declaration);

    if (declaration === undefined || impl === undefined || call.getPos() < impl.getPos() || impl.getEnd() < call.getEnd()) {
        return undefined;
    }

    const [context, candidate] = impl.getParameters();
    const parameter = candidate === undefined || candidate.isRestParameter() ? undefined : candidate;
    const scope = { context, impl, parameter };

    return { ...scope, pristine: parameter !== undefined && isPristineArgsParameter(scope, parameter, declaration) };
};

/** The parameter `declaration` binds: the parameter itself, or the one whose destructuring pattern holds it. */
const parameterOf = (declaration: TsNode | undefined): ParameterDeclaration | undefined => {
    if (Node.isParameterDeclaration(declaration)) {
        return declaration;
    }

    return Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.Parameter) : undefined;
};

/** Whether `identifier` names a value, not a property: the `k` of `x.k` and of `{ k: v }` names a property. */
const isValueIdentifier = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !((Node.isPropertyAssignment(parent) || Node.isMethodDeclaration(parent)) && parent.getNameNode() === identifier);
};

/**
 * Methods that call their callback with the elements, or the settled value, of
 * their RECEIVER, plus their other arguments (`reduce`'s seed). Only for these
 * does a callback's taint come from the receiver; any other callee — a static
 * or namespace function (`Array.from(list, cb)`, `_.map(list, cb)`), `.call` —
 * fails closed.
 */
const RECEIVER_ITERATING_METHODS = new Set<string>([
    "catch",
    "every",
    "filter",
    "finally",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flatMap",
    "forEach",
    "map",
    "reduce",
    "reduceRight",
    "some",
    "sort",
    "then",
]);

/** How many variable hops (`const a = b; const b = c`) taint is followed through before failing closed. */
const MAX_VARIABLE_HOPS = 8;

/**
 * How many uncached verdicts ONE top-level taint query may compute before every
 * further verdict fails closed. A cycle makes the verdicts on it uncachable, so
 * a recursive helper re-derived from many call sites could otherwise cost
 * exponential time. The budget is reset per query and cache hits are free, so
 * a long-lived model (a dev loop reusing the project) never drifts. Realistic
 * impls, and a depth-14 chain of helpers that each call the next twice, stay far
 * below it.
 */
const WORK_BUDGET = 50_000;

/** Memoized verdicts plus the keys being computed, for {@link ImplTaint}'s least-fixed-point recursion. */
interface VerdictTable {
    inProgress: Set<ts.Node>;
    verdicts: Map<ts.Node, boolean>;
}

/** A binding whose object a later statement may change: a variable, a parameter, or one element of a destructuring. */
type ObjectBinding = BindingElement | ParameterDeclaration | VariableDeclaration;

/**
 * Hands {@link ImplTaint}'s flow walk the next binding an object flows into;
 * `isAlias` counts it against the alias hop bound. `true` when that bound is
 * exceeded, which the caller reports as a finding (fail-closed).
 */
type Follow = (next: ObjectBinding, isAlias: boolean) => boolean;

/** The identifier-named elements of a destructuring pattern, nested ones included. */
const bindingIdentifiersOf = (binding: ObjectBinding): BindingElement[] =>
    binding
        .getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .filter((element) => Node.isIdentifier(element.getNameNode()));

/**
 * How taint flows inside one mutator impl, resolved by symbol. Caller-controlled
 * are the impl's own `args` parameter, the `arguments` object, any identifier
 * spelled `args` that is not a nested parameter cleared below, and what derives
 * from them: through variables (followed up to {@link MAX_VARIABLE_HOPS}; a
 * `let` that is reassigned, a variable with no initializer, a `catch` binding,
 * or running out of hops fails closed), through a variable whose object takes
 * a caller-controlled value later (`list.push(args.x)`, `o.k = args.x`,
 * `Object.assign(o, args)`), and through a nested function declaration whose
 * body reads one. A `for…of` / `for…in` variable takes the taint of what it
 * iterates.
 *
 * A value whose member / call chain is ROOTED in the impl's own `ctx`
 * parameter, directly or through `const`s, is server-scoped: rows read through
 * `ctx.db`, even when the query filters on `args`. So is a `Promise`
 * combinator over such reads (`Promise.all(ids.map((id) => ctx.db.get(id)))`).
 * A helper result (`getMembers(ctx, args.orgId)`) is not. Neither is a row that
 * may have been changed since: see {@link ImplTaint.isMutatedWithTaint} and
 * {@link ImplTaint.isChangedUnseen}, which follow the row through `const`
 * aliases, `for…of` variables, iterating callbacks and the parameters of the
 * nested functions it is handed to.
 *
 * A parameter of a function NESTED in the impl is caller-controlled only when
 * what flows into it is. A function called by name (`const persist = …;
 * persist(x)`, a nested `function`, an IIFE) takes taint from the argument at
 * that position at ANY call site; past a spread argument, from every later
 * argument. A function with no visible call site, or one also used as a value
 * (passed on, returned, stored, `.call`ed), fails closed. A callback takes
 * taint from its receiver and the call's other arguments, but only for a
 * {@link RECEIVER_ITERATING_METHODS} method; anything else fails closed. A
 * default, of the parameter or of any element of its destructuring, is
 * followed too.
 *
 * Each verdict is computed once. Recursion resolves to the least fixed point:
 * a cycle adds no taint of its own, and a verdict that depended on a cut cycle
 * (or on the hop bound) is not cached. Past {@link WORK_BUDGET} every verdict
 * fails closed.
 */
class ImplTaint {
    private cuts = 0;

    /** {@link ImplTaint.isChangedUnseen} verdicts, kept apart: they key on the same bindings as the mutation verdicts. */
    private readonly escapes: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    /** {@link ImplTaint.isMutatedWithTaint} verdicts, keyed on the binding like the variable verdicts are. */
    private readonly mutations: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    private readonly referencesByDeclaration = new Map<string, Map<ts.Node, Identifier[]>>();

    private readonly referencesByName = new Map<string, Identifier[]>();

    private readonly scope: MutatorImplScope;

    private readonly taint: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    private variableDepth = 0;

    private queryDepth = 0;

    private work = 0;

    public constructor(scope: MutatorImplScope) {
        this.scope = scope;

        for (const identifier of scope.impl.getDescendantsOfKind(SyntaxKind.Identifier)) {
            const name = identifier.getText();

            this.referencesByName.set(name, [...(this.referencesByName.get(name) ?? []), identifier]);
        }
    }

    /**
     * Whether `value` is caller-controlled. With `rootedInContext`, a value whose
     * member / call chain is rooted in the impl's own `ctx` parameter counts as
     * server-scoped.
     */
    public isTaintedValue(value: TsNode, rootedInContext: boolean): boolean {
        if (this.queryDepth === 0) {
            this.work = 0;
        }

        this.queryDepth += 1;

        try {
            if (rootedInContext && this.isRootedInContext(value, MAX_VARIABLE_HOPS)) {
                return false;
            }

            const identifiers = Node.isIdentifier(value) ? [value] : value.getDescendantsOfKind(SyntaxKind.Identifier);

            return identifiers.some((identifier) => isValueIdentifier(identifier) && this.isIdentifierTainted(identifier));
        } finally {
            this.queryDepth -= 1;
        }
    }

    private flowsIntoTainted(parameter: ParameterDeclaration): boolean {
        const defaults = [parameter.getInitializer(), ...parameter.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getInitializer())];

        if (defaults.some((value) => value !== undefined && this.isTaintedValue(value, false))) {
            return true;
        }

        const nestedFunction = parameter.getParentOrThrow();
        const index = Node.isFunctionLikeDeclaration(nestedFunction)
            ? nestedFunction.getParameters().findIndex((candidate) => candidate.compilerNode === parameter.compilerNode)
            : -1;
        const value = outermostValueWrapper(nestedFunction);
        const holder = value.getParent();

        if (index === -1) {
            return true;
        }

        if (Node.isCallExpression(holder)) {
            // An IIFE is a direct call; anything else receives the function as a callback.
            if (holder.getExpression() === value) {
                return this.isCallSiteTainted(holder, index, parameter.isRestParameter());
            }

            const callee = unwrapExpression(holder.getExpression());

            if (!Node.isPropertyAccessExpression(callee) || !RECEIVER_ITERATING_METHODS.has(callee.getName())) {
                return true;
            }

            const others = holder.getArguments().filter((argument) => argument !== value);

            return this.isTaintedValue(callee.getExpression(), true) || others.some((argument) => this.isTaintedValue(argument, false));
        }

        const binding = Node.isVariableDeclaration(holder) && isConstDeclaration(holder) ? holder : undefined;
        const declaration = Node.isFunctionDeclaration(nestedFunction) ? nestedFunction : binding;
        const nameNode = declaration?.getNameNode();

        if (declaration === undefined || !Node.isIdentifier(nameNode)) {
            return true;
        }

        const references = this.referencesTo(declaration, nameNode.getText());

        return (
            references.length === 0 ||
            references.some((reference) => {
                const callee = outermostValueWrapper(reference);
                const call = callee.getParent();

                return !Node.isCallExpression(call) || call.getExpression() !== callee || this.isCallSiteTainted(call, index, parameter.isRestParameter());
            })
        );
    }

    private isCallSiteTainted(call: CallExpression, index: number, isRest: boolean): boolean {
        const callArguments = call.getArguments();
        const firstSpread = callArguments.findIndex((argument) => Node.isSpreadElement(argument));
        // Past a spread, any later argument may land on any later parameter.
        const reaches = (position: number): boolean =>
            position === index || (isRest && position > index) || (firstSpread !== -1 && firstSpread <= index && position >= firstSpread);

        return callArguments.some((argument, position) => reaches(position) && this.isTaintedValue(argument, false));
    }

    /** `Promise.all([ctx.db.get(a), …])` / `Promise.all(xs.map((x) => ctx.db.get(x)))`: every settled value is ctx-rooted. */
    private isContextRootedCombinator(call: CallExpression, hops: number): boolean {
        const callee = unwrapExpression(call.getExpression());
        const isCombinator =
            Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === "Promise" && PROMISE_COMBINATORS.has(callee.getName());
        const input = isCombinator ? unwrapExpression(call.getArguments()[0]) : undefined;

        if (Node.isArrayLiteralExpression(input)) {
            const elements = input.getElements();

            return elements.length > 0 && elements.every((element) => !Node.isSpreadElement(element) && this.isRootedInContext(element, hops));
        }

        const mapCallee = Node.isCallExpression(input) ? unwrapExpression(input.getExpression()) : undefined;
        const callback =
            Node.isCallExpression(input) && Node.isPropertyAccessExpression(mapCallee) && mapCallee.getName() === "map"
                ? unwrapExpression(input.getArguments()[0])
                : undefined;

        const results = callback === undefined ? undefined : callbackResults(callback);

        return results !== undefined && results.length > 0 && results.every((result) => result !== undefined && this.isRootedInContext(result, hops));
    }

    private isIdentifierTainted(identifier: Identifier): boolean {
        const name = identifier.getText();

        if (name === "arguments") {
            return true;
        }

        const declaration = declarationOf(identifier);
        const parameter = parameterOf(declaration);

        if (parameter !== undefined) {
            return this.isSource(parameter);
        }

        // An `args` that is not, by symbol, a parameter cleared above stays tainted by its spelling.
        if (name === "args") {
            return true;
        }

        if (declaration === undefined || !this.isInImpl(declaration)) {
            return false;
        }

        if (Node.isFunctionDeclaration(declaration)) {
            return this.memoized(declaration.compilerNode, () => this.isTaintedValue(declaration, false));
        }

        // A destructured element is an object of its own, which a later statement may change.
        if (Node.isBindingElement(declaration) && (this.isMutatedWithTaint(declaration) || this.isChangedUnseen(declaration))) {
            return true;
        }

        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;

        return Node.isVariableDeclaration(variable) && this.isVariableTainted(variable, name);
    }

    private isInImpl(node: TsNode): boolean {
        const { impl } = this.scope;

        return node !== impl && impl.getPos() <= node.getPos() && node.getEnd() <= impl.getEnd();
    }

    /**
     * Whether `binding` may have been changed by code this cannot read
     * (fail-closed): its object, a `const` alias of it, or the loop variable of a
     * `for…of` over it is handed to a call that is not a read-only one
     * ({@link isReadOnlyCallArgument}), not `Object.assign`'s target (judged by
     * what it stores, in {@link isMutatedWithTaint}), and not a visible function
     * that keeps it read-only; or a `let` / assignment aliases it, past which
     * its uses are not followed. An iterating callback over it (`rows.forEach(cb)`)
     * and a nested function it is handed to are followed into their parameters.
     * A binding whose type is a primitive cannot be changed in place and never
     * counts.
     */
    private isChangedUnseen(binding: ObjectBinding): boolean {
        return this.reaches(binding, this.escapes, (reference, follow) => this.escapesThrough(reference, follow)) && !isPrimitiveType(binding.getType());
    }

    /** One use of {@link isChangedUnseen}: whether it hands the object to code that may change it unseen. */
    private escapesThrough(reference: Identifier, follow: Follow): boolean {
        const value = outermostValueWrapper(reference);
        const parent = value.getParent();
        const alias = constAliasOf(reference) ?? forOfVariableOf(reference);

        if (alias !== undefined) {
            return follow(alias, true);
        }

        if (Node.isCallExpression(parent) && parent.getArguments().includes(value)) {
            return this.escapesAsArgument(parent, value, follow);
        }

        if (this.escapesAsOperand(reference)) {
            return true;
        }

        const method = Node.isPropertyAccessExpression(parent) && parent.getExpression() === value ? parent : undefined;
        const call = method?.getParent();

        if (method === undefined || !Node.isCallExpression(call) || call.getExpression() !== method || !RECEIVER_ITERATING_METHODS.has(method.getName())) {
            return false;
        }

        const callback = call.getArguments()[0];
        const target = callback === undefined ? undefined : visibleFunctionOf(callback);

        if (callback === undefined) {
            return false;
        }

        if (target === undefined) {
            return true;
        }

        return this.isInImpl(target)
            ? target.getParameters().some((parameter) => follow(parameter, false))
            : !target.getParameters().every((parameter) => isReadOnlyParameter(parameter));
    }

    /**
     * Whether `reference` is aliased by a binding this does not follow
     * (`let alias = row`, `alias = row`; a destructuring only copies members
     * out), spread into a call's arguments that is not read-only, or handed to a
     * constructor or a template tag.
     */
    private escapesAsOperand(reference: Identifier): boolean {
        const value = outermostValueWrapper(reference);
        const parent = value.getParent();

        if (Node.isVariableDeclaration(parent)) {
            return isSameNode(parent.getInitializer(), value) && !Node.isObjectBindingPattern(parent.getNameNode());
        }

        if (Node.isBinaryExpression(parent)) {
            return isSameNode(parent.getRight(), value) && isWriteTarget(parent.getLeft());
        }

        if (Node.isSpreadElement(parent) && Node.isCallExpression(parent.getParent())) {
            return !isReadOnlyCallArgument(parent, this.scope.context);
        }

        return Node.isNewExpression(parent) || (Node.isTemplateSpan(parent) && !isCopiedOnly(reference));
    }

    /** Whether handing `value` to `call` may change it unseen: see {@link isChangedUnseen}. */
    private escapesAsArgument(call: CallExpression, value: TsNode, follow: Follow): boolean {
        if (isReadOnlyCallArgument(value, this.scope.context) || isObjectAssignTarget(call, value)) {
            return false;
        }

        const target = visibleFunctionOf(call.getExpression());
        const parameter = target === undefined ? undefined : receivingParameter(target, call, value);

        if (target === undefined || parameter === undefined) {
            return true;
        }

        if (parameter === null) {
            return false;
        }

        // A nested function's writes are judged by their values (`isMutatedWithTaint`); one outside the impl must only read.
        return this.isInImpl(target) ? follow(parameter, false) : !isReadOnlyParameter(parameter);
    }

    /**
     * Whether a caller-controlled value is stored INTO `binding`'s object after
     * its initializer: a member write (`o.k = args.x`), a method call on it with
     * a tainted argument (`list.push(args.x)`, `map.set(k, args.x)`), a call it
     * is passed to alongside a tainted argument (`Object.assign(o, args)`), or —
     * through a `const` alias of it, the loop variable of a `for…of` over it,
     * an iterating callback over it (`rows.forEach((r) => …)`), or the parameter
     * of a nested function it is handed to (`set(row)`) — any of the same.
     */
    private isMutatedWithTaint(binding: ObjectBinding): boolean {
        return this.reaches(binding, this.mutations, (reference, follow) => this.storesTaintThrough(reference, follow));
    }

    /** One use of {@link isMutatedWithTaint}: whether it stores a caller-controlled value into the object. */
    private storesTaintThrough(reference: Identifier, follow: Follow): boolean {
        const value = outermostValueWrapper(reference);
        let top = value;
        let parent = top.getParent();

        while ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === top) {
            top = outermostValueWrapper(parent);
            parent = top.getParent();
        }

        if (top !== value && isWriteTarget(top)) {
            return !Node.isBinaryExpression(parent) || this.isTaintedValue(parent.getRight(), false);
        }

        const alias = top === value ? (constAliasOf(reference) ?? forOfVariableOf(reference)) : undefined;

        if (alias !== undefined) {
            return follow(alias, true);
        }

        if (!Node.isCallExpression(parent)) {
            return false;
        }

        const callArguments = parent.getArguments();

        if (this.nestedParametersReceiving(parent, top).some((parameter) => follow(parameter, false))) {
            return true;
        }

        // A callback (`rows.filter((r) => r.org === args.org)`) reads the object; it stores nothing into it.
        const others = callArguments.filter((argument) => {
            const unwrapped = unwrapExpression(argument);

            return argument !== top && !Node.isArrowFunction(unwrapped) && !Node.isFunctionExpression(unwrapped);
        });

        return (parent.getExpression() === top || callArguments.includes(top)) && others.some((argument) => this.isTaintedValue(argument, false));
    }

    /**
     * The parameters of functions nested in the impl that receive `node`'s
     * object in `call`: `node` handed to one as an argument (`set(row)`), or the
     * receiver of an iterating method one is the callback of
     * (`rows.forEach((r) => …)`).
     */
    private nestedParametersReceiving(call: CallExpression, node: TsNode): ParameterDeclaration[] {
        if (call.getArguments().includes(node)) {
            const target = visibleFunctionOf(call.getExpression());
            const parameter = target !== undefined && this.isInImpl(target) ? receivingParameter(target, call, node) : undefined;

            return parameter === undefined || parameter === null ? [] : [parameter];
        }

        const method = Node.isPropertyAccessExpression(node) && call.getExpression() === node ? node.getName() : undefined;
        const callback = method !== undefined && RECEIVER_ITERATING_METHODS.has(method) ? call.getArguments()[0] : undefined;
        const target = callback === undefined ? undefined : visibleFunctionOf(callback);

        return target !== undefined && this.isInImpl(target) ? target.getParameters() : [];
    }

    /**
     * Whether any binding `root`'s object flows into — `root` itself, and every
     * binding `visit` hands to `follow`, transitively — has a use `visit` judges
     * bad. A breadth-first walk over that flow, not a recursion: a recursive
     * helper (`walk(n)` calling `walk(n.child)`) puts its parameter on a cycle,
     * and a recursion would have to leave every verdict on it uncached. Alias
     * hops (`follow(next, true)`) are bounded by {@link MAX_VARIABLE_HOPS} per
     * path, past which the walk fails closed. When nothing is found (and no cut
     * cycle or bound was involved), every binding visited is clean too — its own
     * flow is part of `root`'s — so each is cached as such.
     */
    private reaches(root: ObjectBinding, table: VerdictTable, visit: (reference: Identifier, follow: Follow) => boolean): boolean {
        return this.memoized(
            root.compilerNode,
            () => {
                const cutsBefore = this.cuts;
                const queue: { binding: ObjectBinding; hops: number }[] = [{ binding: root, hops: 0 }];
                const seen = new Set<ts.Node>([root.compilerNode]);
                let found = false;
                const enqueue = (binding: ObjectBinding, hops: number): void => {
                    if (!seen.has(binding.compilerNode)) {
                        seen.add(binding.compilerNode);
                        queue.push({ binding, hops });
                    }
                };

                for (let index = 0; index < queue.length && !found; index += 1) {
                    const { binding, hops } = queue[index] as { binding: ObjectBinding; hops: number };
                    const known = binding === root ? undefined : table.verdicts.get(binding.compilerNode);
                    const follow: Follow = (next, isAlias) => {
                        if (isAlias && hops >= MAX_VARIABLE_HOPS) {
                            this.cuts += 1;

                            return true;
                        }

                        enqueue(next, isAlias ? hops + 1 : hops);

                        return false;
                    };

                    found = known ?? this.visitBinding(binding, visit, follow, enqueue, hops);
                }

                if (!found && this.cuts === cutsBefore) {
                    for (const node of seen) {
                        table.verdicts.set(node, false);
                    }
                }

                return found;
            },
            table,
        );
    }

    /** Expand one binding of {@link reaches}: its references, or a destructured parameter's elements. */
    private visitBinding(
        binding: ObjectBinding,
        visit: (reference: Identifier, follow: Follow) => boolean,
        follow: Follow,
        enqueue: (binding: ObjectBinding, hops: number) => void,
        hops: number,
    ): boolean {
        const nameNode = binding.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            // A destructured parameter binds members of what it receives, each an object of its own.
            if (Node.isParameterDeclaration(binding)) {
                for (const element of bindingIdentifiersOf(binding)) {
                    enqueue(element, hops);
                }
            }

            return false;
        }

        this.work += 1;

        if (this.work > WORK_BUDGET) {
            this.cuts += 1;

            return true;
        }

        return this.referencesTo(binding, nameNode.getText()).some((reference) => visit(reference, follow));
    }

    /**
     * What one call on a chain settles: `true` for a `Promise` combinator over
     * ctx reads, `false` for an {@link ECHOING_CONTEXT_METHODS} call, otherwise
     * nothing (keep walking).
     */
    private callChainVerdict(call: CallExpression, hops: number): boolean | undefined {
        if (this.isContextRootedCombinator(call, hops)) {
            return true;
        }

        const callee = unwrapExpression(call.getExpression());
        const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;

        if (method !== undefined && ECHOING_CONTEXT_METHODS.has(method)) {
            return false;
        }

        if (method !== undefined && CALLBACK_RESULT_METHODS.has(method)) {
            return this.isCallbackResultServerScoped(call, hops) ? undefined : false;
        }

        // A method that returns its receiver (or one of its elements) passes through;
        // any other method handed an inline callback may return that callback's value.
        const takesCallback = call.getArguments().some((argument) => callbackResults(argument) !== undefined);

        return takesCallback && (method === undefined || !RECEIVER_RESULT_METHODS.has(method)) ? false : undefined;
    }

    /**
     * Whether every value a callback-result call (`then`, `map`, `reduce`, …) can
     * produce is server-scoped: each inline callback's returned value is rooted
     * in `ctx`, rooted in one of that callback's own parameters (which carry the
     * ctx-rooted receiver's elements), or clean; and every other argument (a
     * `reduce` seed) is rooted in `ctx` or clean. A callback passed by reference
     * fails closed.
     */
    private isCallbackResultServerScoped(call: CallExpression, hops: number): boolean {
        const isServerScoped = (value: TsNode, callbackParameters: ReadonlyArray<ParameterDeclaration> = []): boolean => {
            const root = chainRootOf(value);
            const parameter = Node.isIdentifier(root) ? parameterOf(declarationOf(root)) : undefined;

            if (parameter !== undefined && callbackParameters.includes(parameter)) {
                return true;
            }

            return this.isRootedInContext(value, hops) || !this.isTaintedValue(value, false);
        };

        return call.getArguments().every((argument) => {
            const results = callbackResults(argument);

            if (results === undefined) {
                return !isFunctionReference(argument) && isServerScoped(argument);
            }

            const callback = unwrapExpression(argument);
            const parameters = Node.isArrowFunction(callback) || Node.isFunctionExpression(callback) ? callback.getParameters() : [];

            return results.every((result) => result === undefined || isServerScoped(result, parameters));
        });
    }

    /** Whether `value`'s member / call chain is rooted, by symbol, in the impl's `ctx` parameter (directly or through `const`s). */
    private isRootedInContext(value: TsNode, hops: number): boolean {
        let current: TsNode | undefined = unwrapExpression(value);

        while (
            Node.isAwaitExpression(current) ||
            Node.isPropertyAccessExpression(current) ||
            Node.isElementAccessExpression(current) ||
            Node.isCallExpression(current)
        ) {
            const verdict = Node.isCallExpression(current) ? this.callChainVerdict(current, hops) : undefined;

            if (verdict !== undefined) {
                return verdict;
            }

            current = unwrapExpression(current.getExpression());
        }

        if (isContextReference(current, this.scope.context)) {
            return true;
        }

        const declaration = Node.isIdentifier(current) ? declarationOf(current) : undefined;
        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;
        const initializer = isConstDeclaration(variable) && this.isInImpl(variable) ? variable.getInitializer() : undefined;
        const binding = Node.isBindingElement(declaration) ? declaration : variable;

        return (
            hops > 0 &&
            initializer !== undefined &&
            (Node.isBindingElement(binding) || Node.isVariableDeclaration(binding)) &&
            !this.isMutatedWithTaint(binding) &&
            !this.isChangedUnseen(binding) &&
            this.isRootedInContext(initializer, hops - 1)
        );
    }

    private isSource(parameter: ParameterDeclaration): boolean {
        const { impl, parameter: argsParameter } = this.scope;

        if (parameter.compilerNode === argsParameter?.compilerNode) {
            return true;
        }

        // A nested parameter is caller-controlled when what flows into it is, or when its object is changed afterwards.
        return (
            parameter.getParent() !== impl &&
            this.isInImpl(parameter) &&
            (this.memoized(parameter.compilerNode, () => this.flowsIntoTainted(parameter)) ||
                this.isMutatedWithTaint(parameter) ||
                this.isChangedUnseen(parameter))
        );
    }

    private isVariableTainted(variable: VariableDeclaration, name: string): boolean {
        return this.memoized(variable.compilerNode, () => {
            const holder = variable.getParent().getParent();

            if (Node.isCatchClause(variable.getParent()) || this.isMutatedWithTaint(variable) || this.isChangedUnseen(variable)) {
                return true;
            }

            if (Node.isForOfStatement(holder) || Node.isForInStatement(holder)) {
                return this.isTaintedValue(holder.getExpression(), true);
            }

            const initializer = variable.getInitializer();
            const isReassigned = !isConstDeclaration(variable) && this.referencesTo(variable, name).some((reference) => isWriteTarget(reference));

            if (initializer === undefined || isReassigned) {
                return true;
            }

            if (this.isRootedInContext(initializer, MAX_VARIABLE_HOPS)) {
                return false;
            }

            if (this.variableDepth >= MAX_VARIABLE_HOPS) {
                this.cuts += 1;

                return true;
            }

            this.variableDepth += 1;

            try {
                return this.isTaintedValue(initializer, false);
            } finally {
                this.variableDepth -= 1;
            }
        });
    }

    private memoized(key: ts.Node, compute: () => boolean, table: VerdictTable = this.taint): boolean {
        const known = table.verdicts.get(key);

        if (known !== undefined) {
            return known;
        }

        if (table.inProgress.has(key)) {
            this.cuts += 1;

            return false;
        }

        this.work += 1;

        if (this.work > WORK_BUDGET) {
            this.cuts += 1;

            return true;
        }

        const cutsBefore = this.cuts;

        table.inProgress.add(key);

        let verdict: boolean;

        try {
            verdict = compute();
        } finally {
            table.inProgress.delete(key);
        }

        if (this.cuts === cutsBefore) {
            table.verdicts.set(key, verdict);
        }

        return verdict;
    }

    /**
     * The references to `declaration` (spelled `name`) inside the impl. The
     * identifiers spelled `name` are resolved once, on the first query for that
     * spelling, and grouped by declaration: many same-named bindings (300
     * helpers each taking `d`) then cost one symbol lookup per identifier, not
     * one per identifier per binding.
     */
    private referencesTo(declaration: TsNode, name: string): Identifier[] {
        let byDeclaration = this.referencesByDeclaration.get(name);

        if (byDeclaration === undefined) {
            byDeclaration = new Map();

            for (const reference of this.referencesByName.get(name) ?? []) {
                const target = declarationOf(reference)?.compilerNode;

                if (target !== undefined) {
                    byDeclaration.set(target, [...(byDeclaration.get(target) ?? []), reference]);
                }
            }

            this.referencesByDeclaration.set(name, byDeclaration);
        }

        return (byDeclaration.get(declaration.compilerNode) ?? []).filter((reference) => reference.getParent() !== declaration);
    }
}

/** One {@link ImplTaint} per impl, keyed on the compiler node so a re-parse rebuilds it. */
const IMPL_TAINT_CACHE = new WeakMap<ts.Node, ImplTaint>();

/** The {@link ImplTaint} of `scope`'s impl, built once. */
const implTaintOf = (scope: MutatorImplScope): ImplTaint => {
    const cached = IMPL_TAINT_CACHE.get(scope.impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const taint = new ImplTaint(scope);

    IMPL_TAINT_CACHE.set(scope.impl.compilerNode, taint);

    return taint;
};

/** The object `node` reads `field` from (`<object>.<field>`, `<object>?.<field>`, `<object>["<field>"]`), unwrapped; else `undefined`. */
const ownerPropertyObject = (node: TsNode, field: string): TsNode | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName() === field ? unwrapExpression(node.getExpression()) : undefined;
    }

    if (Node.isElementAccessExpression(node)) {
        const argument = node.getArgumentExpression();

        return argument !== undefined && Node.isStringLiteral(argument) && argument.getLiteralValue() === field
            ? unwrapExpression(node.getExpression())
            : undefined;
    }

    return undefined;
};

/** Whether `node` is an identifier resolving, by symbol, to `parameter` itself. */
const isParameterReference = (node: TsNode | undefined, parameter: ParameterDeclaration): boolean =>
    Node.isIdentifier(node) && declarationOf(node)?.compilerNode === parameter.compilerNode;

/**
 * Whether `value` resolves to the verified `args[owner]` of a PRISTINE impl
 * parameter `parameter`: `args.<owner>` / `args?.<owner>` / `args["<owner>"]`,
 * the `<owner>` element of the destructured parameter (`(ctx, { userId })`) or
 * of a `const` destructure of it (`const { userId } = args`) — directly or
 * through one `const` alias. `applyOwnerScope` stamps the parsed args BEFORE
 * `server(context, args)` runs, so each of these reads the stamped value.
 *
 * Every identifier is resolved by SYMBOL: a nested closure's own `args`, a
 * shadowing `for` / `catch` / block binding, or anything else merely spelled
 * `args` resolves elsewhere. The column NAME matching `owner` is not enough
 * either: `{ userId: args.targetUserId }` is a genuine act-as-any-user IDOR. A
 * `let` destructure or alias, a nested destructuring, or a rest element falls
 * through as NOT owner-scoped, which fails toward reporting.
 */
const resolvesToOwnerArgument = (value: TsNode, parameter: ParameterDeclaration, ownerField: string, hops = 1): boolean => {
    const object = ownerPropertyObject(value, ownerField);

    if (object !== undefined) {
        return isParameterReference(object, parameter);
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    if (Node.isBindingElement(declaration)) {
        const pattern = declaration.getParent();
        const holder = pattern.getParent();
        const isOwnerElement =
            declaration.getDotDotDotToken() === undefined && bindingKeyName(declaration) === ownerField && Node.isObjectBindingPattern(pattern);

        return (
            isOwnerElement &&
            (holder.compilerNode === parameter.compilerNode ||
                (isConstDeclaration(holder) && isParameterReference(unwrapExpression(holder.getInitializer()), parameter)))
        );
    }

    const initializer = isConstDeclaration(declaration) ? declaration.getInitializer() : undefined;

    return hops > 0 && initializer !== undefined && resolvesToOwnerArgument(initializer, parameter, ownerField, hops - 1);
};

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    write: { call: CallExpression; method: string; ownerField: string | undefined; relativePath: string; scope: CallSiteScope },
    implScope: MutatorImplScope | undefined,
): OwnerFieldWriteIR[] => {
    const rows: OwnerFieldWriteIR[] = [];
    const taint = implScope === undefined ? undefined : implTaintOf(implScope);

    for (const property of objectLiteral.getProperties()) {
        let name: string | undefined;
        let value: TsNode | undefined;

        if (Node.isPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getInitializer();
        } else if (Node.isShorthandPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getNameNode();
        }

        if (name === undefined || value === undefined || !IDENTITY_FIELDS.has(name)) {
            continue;
        }

        // Correct: `userId: ctx.auth.userId`; offending: `userId: args.userId`.
        // Outside a mutator impl, a value that references `ctx` is server-scoped
        // even when it also embeds `args` — the shared taint convention. Inside
        // one, taint is resolved by symbol and only a value ROOTED in the impl's
        // `ctx` is server-scoped (see `ImplTaint`): `ctx.auth.userId ?? args.x`
        // is not.
        const isTainted = taint === undefined ? isArgumentDerived(value) && !isScopedByContext(value) : taint.isTaintedValue(value, true);

        if (isTainted) {
            // Recorded either way — the lint decides what to do with it. Dropping it
            // here would make the feeder the only place that knows the write
            // happened, and the `visibility` stamp is the precedent for annotating
            // rather than discarding.
            //
            // Owner-scoped ONLY when the value is, by symbol, the `args[owner]` the
            // runtime verified: `applyOwnerScope` stamps the parsed args object this
            // export's `defineMutator` `server` impl receives as its 2nd parameter,
            // and nothing else. A write anywhere in that impl, nested closures
            // included, qualifies iff it reads THAT parameter and the impl never
            // rewrites or lets it escape. A helper's or a nested function's own
            // parameters can be filled from anything, so they never qualify.
            const ownerScoped =
                write.ownerField === name &&
                implScope?.parameter !== undefined &&
                implScope.pristine &&
                resolvesToOwnerArgument(value, implScope.parameter, name);

            rows.push({
                field: name,
                file: write.relativePath,
                line: write.call.getStartLineNumber(),
                method: write.method,
                scope: write.scope,
                ...(ownerScoped && { ownerScoped: true }),
            });
        }
    }

    return rows;
};

/** Identity columns written from `args` by a single `ctx.db` write call. */
const ownerFieldWritesInCall = (call: CallExpression, relativePath: string, ownerFieldOf: (exportName: string) => string | undefined): OwnerFieldWriteIR[] => {
    const method = contextDatabaseWriteMethod(call.getExpression());
    const documentArgument = method === undefined ? undefined : call.getArguments()[1];

    if (method === undefined || documentArgument === undefined) {
        return [];
    }

    const objectLiterals = documentObjectLiterals(documentArgument, method);

    if (objectLiterals.length === 0) {
        return [];
    }

    const scope = callSiteScopeOf(call);
    const isExport = scope.kind === "export";
    const write = { call, method, ownerField: isExport ? ownerFieldOf(scope.name) : undefined, relativePath, scope };
    const implScope = isExport ? mutatorImplScopeOf(call) : undefined;

    return objectLiterals.flatMap((objectLiteral) => identityWritesInObjectLiteral(objectLiteral, write, implScope));
};

/**
 * Discover `ctx.db` writes (`insert`, `replace`, `patch`, `insertManyUnsafe`) in
 * `lunora/` that set an ownership / identity column — `userId`, `ownerId`,
 * `tenantId`, and the like — from the handler's `args` instead of the
 * server-trusted identity. This is the `owner_field_from_args_not_auth` lint
 * input: the ownership column decides who a row belongs to, so a value taken from
 * request input lets any caller write rows owned by another user or tenant (the
 * act-as-any-user / cross-tenant IDOR vector). A column stamped from `ctx.*`, or
 * set to a fixed literal, is not recorded; only an arg-derived identity write
 * (directly, or through one local `const` hop) reaches here.
 */
const discoverOwnerFieldWrites = (
    project: Project,
    lunoraDirectory: string,
    functions: ReadonlyArray<FunctionIR> = [],
    mutators: ReadonlyArray<MutatorIR> = [],
): OwnerFieldWriteIR[] => {
    // Keyed on file + export because two modules may export the same name.
    const ownerByKey = new Map(mutators.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.owner]));
    const writes = collectCallRows(project, lunoraDirectory, (call, relativePath) =>
        ownerFieldWritesInCall(call, relativePath, (exportName) => ownerByKey.get(`${relativePath}:${exportName}`)),
    );

    return withCallerVisibility(writes, functions);
};

export default discoverOwnerFieldWrites;
