/**
 * Use predicates shared by the owner-field analysis: which uses of a value only
 * read it, which calls this can see into, and which parameter receives an argument.
 */
import type { ArrowFunction, CallExpression, FunctionDeclaration, FunctionExpression, Identifier, Node as TsNode, ParameterDeclaration, ts } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isConstDeclaration, isWriteTarget, outermostValueWrapper, unwrapExpression } from "../ast";
import { declarationOf } from "../attribution";

/**
 * `ctx` methods whose result echoes caller-chosen input: `ctx.db.asId(table, args.x)`
 * returns that very id, and a `ctx.run*` result can hand its args straight
 * back. A chain through one of these is not server-scoped; its taint is that
 * of its arguments.
 */
const ECHOING_CONTEXT_METHODS = new Set<string>(["asId", "runAction", "runMutation", "runQuery"]);

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

export {
    chainRootOf,
    ECHOING_CONTEXT_METHODS,
    isContextReference,
    isCopiedOnly,
    isDestructuringRead,
    isLibraryGlobal,
    isMemberRead,
    isObjectAssignTarget,
    isReadOnlyCallArgument,
    isReadOnlyParameter,
    isReassignedFunction,
    isSameNode,
    receivingParameter,
    visibleArgumentTarget,
    visibleFunctionOf,
};
export type { VisibleFunction };
