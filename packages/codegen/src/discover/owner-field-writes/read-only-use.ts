/**
 * Use predicates shared by the owner-field analysis: which uses of a value only
 * read it, which calls this can see into, and which parameter receives an argument.
 */
import type { ArrowFunction, CallExpression, FunctionDeclaration, FunctionExpression, Identifier, Node as TsNode, ParameterDeclaration, ts } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { chainRootOf, isConstDeclaration, isSameNode, isWriteTarget, outermostValueWrapper, unwrapExpression } from "../ast";
import { declarationOf, isReassignedBinding, isTypePosition } from "../attribution";
import { ECHOING_CONTEXT_METHODS } from "../context-root";

/** Whether `node` resolves, by symbol, to the impl's `ctx` parameter or to a binding destructured out of it (`{ db }`). */
const isImplContextReference = (node: TsNode | undefined, context: ParameterDeclaration | undefined): boolean => {
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

    if (isImplContextReference(chainRootOf(callee), context)) {
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

/**
 * Which parameter of a {@link VisibleFunction} receives a call argument:
 * `parameter`; `unreached` when none does, so the function cannot see it; or
 * `opaque` when that cannot be told (an unreadable callee, a spread argument at
 * or before it, a rest parameter, `arguments` read in the function).
 */
type ArgumentTarget = { kind: "opaque" } | { kind: "parameter"; parameter: ParameterDeclaration } | { kind: "unreached" };

const OPAQUE: ArgumentTarget = { kind: "opaque" };

const UNREACHED: ArgumentTarget = { kind: "unreached" };

/**
 * The implementation a same-file `function` binding runs: the declaration with
 * a body among its overloads, when every declaration of the name is a
 * `function` overload in this file and exactly one has a body.
 */
const functionImplementationOf = (declaration: FunctionDeclaration): FunctionDeclaration | undefined => {
    const declarations = declaration.getSymbol()?.getDeclarations() ?? [];
    const implementations = declarations.filter((candidate) => Node.isFunctionDeclaration(candidate) && candidate.hasBody());
    const [implementation] = implementations;
    const isOverloadSet = declarations.every((candidate) => Node.isFunctionDeclaration(candidate) && candidate.getSourceFile() === declaration.getSourceFile());

    return isOverloadSet && implementations.length === 1 && Node.isFunctionDeclaration(implementation) ? implementation : undefined;
};

/**
 * The function `callee` runs when this analysis can read its body: an inline
 * arrow / function expression (an IIFE), or an identifier bound IN THE SAME
 * FILE to a `function` declaration (the one implementation of its overloads,
 * never reassigned) or to a `const` initialized with an arrow / function
 * expression. Anything else — an import, a parameter, a `let`, a method — is
 * `undefined`.
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
        const implementation = functionImplementationOf(declaration);

        return implementation === undefined || isReassignedBinding(implementation) ? undefined : implementation;
    }

    const initializer = isConstDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;

    return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer) ? initializer : undefined;
};

/** The {@link ArgumentTarget} of `argument` in `call` to `target`. */
const receivingParameter = (target: VisibleFunction, call: CallExpression, argument: TsNode): ArgumentTarget => {
    const callArguments = call.getArguments();
    const position = callArguments.indexOf(argument);
    const isOpaque =
        position === -1 ||
        callArguments.slice(0, position + 1).some((candidate) => Node.isSpreadElement(candidate)) ||
        target.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => identifier.getText() === "arguments");
    const parameters = target.getParameters();
    const parameter = parameters[position];

    if (isOpaque) {
        return OPAQUE;
    }

    if (parameter === undefined) {
        return parameters.some((candidate) => candidate.isRestParameter()) ? OPAQUE : UNREACHED;
    }

    return parameter.isRestParameter() ? OPAQUE : { kind: "parameter", parameter };
};

/**
 * The {@link ArgumentTarget} of `node` as an argument of the call it is passed
 * to (`validate(args)`): `opaque` when the callee is not a
 * {@link visibleFunctionOf} function; `undefined` when `node` is no call argument.
 */
const visibleArgumentTarget = (node: TsNode): ArgumentTarget | undefined => {
    const value = outermostValueWrapper(node);
    const call = value.getParent();

    if (!Node.isCallExpression(call) || call.getExpression() === value) {
        return undefined;
    }

    const target = visibleFunctionOf(call.getExpression());

    return target === undefined ? OPAQUE : receivingParameter(target, call, value);
};

/**
 * Members whose READ hands out a way to rewrite the object: legacy accessor
 * definers (`args.__defineGetter__("userId", …)`) and the prototype.
 */
const MUTATING_MEMBERS = new Set<string>(["__defineGetter__", "__defineSetter__", "__proto__"]);

/** The operand of `parent` that is only read: what a `for…in` enumerates, the test of `a ? b : c`, an index. */
const readOperandOf = (parent: TsNode | undefined): TsNode | undefined => {
    if (Node.isForInStatement(parent)) {
        return parent.getExpression();
    }

    if (Node.isConditionalExpression(parent)) {
        return parent.getCondition();
    }

    return Node.isElementAccessExpression(parent) ? parent.getArgumentExpression() : undefined;
};

/**
 * Whether `node` is only tested, compared or interpolated: a condition
 * (`if (!input)`, `while`, `switch` / `case`, the test of `a ? b : c`), a `!` /
 * `-` / `typeof` / `void` operand, an operand of a comparison or arithmetic
 * operator, an index (`x[node]`, `{ [node]: … }`), a template interpolation, or
 * the object a `for…in` enumerates the keys of. `??` / `||` / `&&` hand the
 * value itself on and `++` / `--` rebind it, so they are not.
 */
const isReadOperand = (node: TsNode): boolean => {
    const value = outermostValueWrapper(node);
    const parent = value.getParent();

    if (
        Node.isIfStatement(parent) ||
        Node.isWhileStatement(parent) ||
        Node.isDoStatement(parent) ||
        Node.isSwitchStatement(parent) ||
        Node.isCaseClause(parent) ||
        Node.isTypeOfExpression(parent) ||
        Node.isVoidExpression(parent) ||
        Node.isComputedPropertyName(parent)
    ) {
        return true;
    }

    // An untagged template only stringifies it; a tag receives the value itself.
    if (Node.isTemplateSpan(parent)) {
        return !Node.isTaggedTemplateExpression(parent.getParent().getParent());
    }

    const operand = readOperandOf(parent);

    if (operand !== undefined) {
        return isSameNode(operand, value);
    }

    if (Node.isPrefixUnaryExpression(parent)) {
        return parent.getOperatorToken() !== SyntaxKind.PlusPlusToken && parent.getOperatorToken() !== SyntaxKind.MinusMinusToken;
    }

    if (!Node.isBinaryExpression(parent)) {
        return false;
    }

    const operator = parent.getOperatorToken().getKind();
    const isAssignment = operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
    const isLogical = operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken || operator === SyntaxKind.AmpersandAmpersandToken;

    return !isAssignment && !isLogical;
};

/** How many nested {@link isReadOnlyParameter} hand-offs (`validate` → `check` → …) are followed before failing closed. */
const MAX_READ_ONLY_DEPTH = 4;

/**
 * Whether `reference` only READS the object it names: a member read (not of a
 * {@link MUTATING_MEMBERS} member), a destructuring initializer, a copy
 * ({@link isCopiedOnly}), a read-only call argument ({@link isReadOnlyCallArgument},
 * with `context` the impl's own `ctx`), an argument to a visible function that
 * is read-only for it ({@link isReadOnlyParameter}), or a TYPE position
 * (`typeof args`), which is no use of the value at all.
 */
const isReadOnlyUse = (reference: Identifier, context: ParameterDeclaration | undefined, depth = 0): boolean => {
    if (isTypePosition(reference)) {
        return true;
    }

    if (isMemberRead(reference)) {
        const access = outermostValueWrapper(reference).getParent();
        const key = Node.isElementAccessExpression(access) ? access.getArgumentExpression() : undefined;
        const literalKey = Node.isStringLiteral(key) ? key.getLiteralValue() : undefined;
        const member = Node.isPropertyAccessExpression(access) ? access.getName() : literalKey;

        return member === undefined || !MUTATING_MEMBERS.has(member);
    }

    if (isDestructuringRead(reference) || isCopiedOnly(reference) || isReadOperand(reference) || isReadOnlyCallArgument(reference, context)) {
        return true;
    }

    const target = visibleArgumentTarget(reference);

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with isReadOnlyParameter
    return target?.kind === "unreached" || (target?.kind === "parameter" && isReadOnlyParameter(target.parameter, depth + 1));
};

/** Per-parameter {@link isReadOnlyParameter} verdicts (keyed on the compiler node), kept when they did not hit the depth bound. */
const READ_ONLY_PARAMETER_CACHE = new WeakMap<ts.Node, boolean>();

/**
 * Whether the function `parameter` belongs to only READS what it is handed
 * there: declared once (no `var` redeclaration), and every use of it
 * {@link isReadOnlyUse}, following hand-offs to further visible functions up to
 * {@link MAX_READ_ONLY_DEPTH}. Never written through, returned, stored or
 * aliased, and never passed to a function this cannot read. A destructured
 * parameter only copies members out, so it is read-only; a rest parameter never
 * reaches here ({@link receivingParameter}).
 */
const isReadOnlyParameter = (parameter: ParameterDeclaration, depth = 0): boolean => {
    const name = parameter.getNameNode();

    if (!Node.isIdentifier(name)) {
        return true;
    }

    const cached = READ_ONLY_PARAMETER_CACHE.get(parameter.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    if (depth > MAX_READ_ONLY_DEPTH) {
        return false;
    }

    const isSingle = (name.getSymbol()?.getDeclarations().length ?? 0) === 1;
    const readOnly =
        isSingle &&
        parameter
            .getParentOrThrow()
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .every(
                (identifier) =>
                    identifier === name ||
                    identifier.getText() !== name.getText() ||
                    declarationOf(identifier)?.compilerNode !== parameter.compilerNode ||
                    isReadOnlyUse(identifier, undefined, depth),
            );

    // A verdict reached with depth to spare holds at any depth; a refusal at depth may only be the bound.
    if (readOnly || depth === 0) {
        READ_ONLY_PARAMETER_CACHE.set(parameter.compilerNode, readOnly);
    }

    return readOnly;
};

export { isImplContextReference, isLibraryGlobal, isReadOnlyCallArgument, isReadOnlyUse, isReadOperand, receivingParameter, visibleFunctionOf };
