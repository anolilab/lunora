import type {
    ArrowFunction,
    BindingElement,
    CallExpression,
    ElementAccessExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    Node as TsNode,
    ObjectLiteralElementLike,
    ObjectLiteralExpression,
    ParameterDeclaration,
    PropertyAccessExpression,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { bindingKeyName, descendantsOfKind, findObjectProperty, isConstDeclaration, propertyKeyName, unwrapExpression } from "./discover/ast";
import { declarationOf, isReassignedBinding, referencedSymbolOf } from "./discover/attribution";
import { contextTrustPathOf, isHandlerArgsParameter, referencesContext } from "./discover/context-root";
import { staticPropertyName } from "./discover/property-name";

/**
 * The parameter binding element that declares `name`, searched from the
 * innermost enclosing function outward so a shadowing parameter wins over an
 * outer one. Only PARAMETER patterns are searched: `({ args: { url } })` is the
 * house style every handler is written in, and a parameter cannot be
 * reassigned out from under the use the way a later `const` can, so this needs
 * none of {@link singleHopInitializer}'s scope-order care.
 */
const parameterBindingFor = (identifier: Identifier): BindingElement | undefined => {
    const name = identifier.getText();
    const declares = (candidate: BindingElement): boolean => {
        const nameNode = candidate.getNameNode();

        return Node.isIdentifier(nameNode) && nameNode.getText() === name;
    };

    for (const ancestor of identifier.getAncestors()) {
        if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor) && !Node.isFunctionDeclaration(ancestor)) {
            continue;
        }

        for (const parameter of ancestor.getParameters()) {
            const element = parameter.getDescendantsOfKind(SyntaxKind.BindingElement).find((candidate) => declares(candidate));

            if (element !== undefined) {
                return element;
            }
        }
    }

    return undefined;
};

/**
 * The property name the outermost element of `element`'s destructuring chain
 * reads off the parameter object — `({ args: { url: target } })`'s `target`
 * resolves to `"args"`, and so does the `...rest` of `({ args: { url,
 * ...rest } })`, because a rest element holds what is left of the same object.
 * `undefined` when the chain is not rooted directly in a parameter's pattern
 * (an array pattern, or a nested function's own binding).
 */
const destructuringRootName = (element: BindingElement): string | undefined => {
    let outermost = element;

    for (;;) {
        const pattern = outermost.getParent();

        if (!Node.isObjectBindingPattern(pattern)) {
            return undefined;
        }

        const owner = pattern.getParent();

        if (Node.isBindingElement(owner)) {
            outermost = owner;

            continue;
        }

        if (!Node.isParameterDeclaration(owner)) {
            return undefined;
        }

        // The renamed spelling reads `propertyName`; a shorthand (and a rest
        // element) reads its own name.
        return bindingKeyName(outermost);
    }
};

/** Whether `identifier` resolves, by symbol, to a positional handler's `args` parameter or to a binding destructured from it. */
const isPositionalArgsReference = (identifier: Identifier): boolean => {
    // Cheap pre-filter before any symbol lookup: some enclosing positional handler binds this spelling as its `args`.
    const name = identifier.getText();
    const isCandidate = identifier.getAncestors().some((ancestor) => {
        const parameter = Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor) ? ancestor.getParameters()[1] : undefined;
        const nameNode = parameter?.getNameNode();

        return (
            parameter !== undefined &&
            (Node.isIdentifier(nameNode)
                ? nameNode.getText() === name
                : parameter.getDescendantsOfKind(SyntaxKind.BindingElement).some((element) => element.getName() === name)) &&
            isHandlerArgsParameter(parameter)
        );
    });

    if (!isCandidate) {
        return false;
    }

    const declaration = declarationOf(identifier);
    const parameter = Node.isParameterDeclaration(declaration) ? declaration : declaration?.getFirstAncestorByKind(SyntaxKind.Parameter);

    return parameter !== undefined && (Node.isParameterDeclaration(declaration) || Node.isBindingElement(declaration)) && isHandlerArgsParameter(parameter);
};

/**
 * True when `identifier` is a *value* reference to the binding named `name` —
 * the taint-root check shared by every Wave 3 feeder, whether the root is the
 * fixed `args`/`ctx` binding or an `httpAction` handler's freely-named request
 * parameter (`request` / `req` / `r`). Excludes the trailing `.<name>` of a
 * member access and the key of an explicit `{ <name>: … }` property, which name
 * a different `<name>` and carry no taint; a `{ <name> }` shorthand IS a value
 * reference and is kept.
 *
 * A handler that destructures its parameter — `({ args: { url }, ctx }) => …
 * url` — binds `url` to a field OF `args`, so `url` is a value reference to
 * `args` just as `args.url` is. Renaming (`{ args: { url: target } }`),
 * nesting, and rest elements all resolve through the same chain walk. Without
 * this the destructured spelling (the one every registry item, example and doc
 * snippet is written in) carried no taint at all, so three ERROR/WARN sink
 * lints could not fire on the code this repo itself ships.
 */
const isValueReference = (identifier: Identifier, name: string): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (identifier.getText() === name) {
        return true;
    }

    const element = parameterBindingFor(identifier);

    if (element !== undefined && destructuringRootName(element) === name) {
        return true;
    }

    // A positional handler's `args` under any name: `handler: (c, a) => … a.userId`, `(c, { userId })`.
    return name === "args" && isPositionalArgsReference(identifier);
};

/** True when `node` is, or textually contains, a value reference to the binding named `name`. */
const referencesBinding = (node: TsNode, name: string): boolean => {
    if (Node.isIdentifier(node)) {
        return isValueReference(node, name);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isValueReference(identifier, name));
};

/**
 * The leftmost identifier of a member/element-access (and non-null) chain
 * (`body.tag.id` → `body`), or `undefined` when the chain doesn't root at a bare
 * identifier. Lets the request taint follow one hop through the *object* of a
 * member access (`const body = await request.json(); … body.tag`), which the
 * bare-identifier {@link singleHopInitializer} hop alone cannot reach.
 */
const memberAccessRootIdentifier = (node: TsNode): Identifier | undefined => {
    let current: TsNode = node;

    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current) || Node.isNonNullExpression(current)) {
        current = current.getExpression();
    }

    return Node.isIdentifier(current) ? current : undefined;
};

/**
 * The initializer of the variable `node` names, resolved by symbol, when that
 * binding cannot have been repointed since (a `const`, or a `let` never
 * reassigned) — the hop a SUPPRESSOR may follow. `singleHopInitializer` is the
 * looser, spelling-based hop the taint side uses.
 */
const trustedInitializerOf = (node: TsNode): TsNode | undefined => {
    const declaration = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    return Node.isVariableDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) && !isReassignedBinding(declaration)
        ? declaration.getInitializer()
        : undefined;
};

/**
 * The node a declaration's binding is visible in: the enclosing function for a
 * `var`, else the block, `for` statement or file that holds the `let`/`const`.
 */
const bindingScope = (variable: VariableDeclaration, enclosingFunction: TsNode): TsNode | undefined => {
    const list = variable.getParent();

    if (Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Var) {
        return enclosingFunction;
    }

    const holder = list.getParent();

    return Node.isVariableStatement(holder) ? holder.getParent() : holder;
};

/** Whether `variable` binds `name` directly, or as an identifier anywhere inside a destructuring pattern. */
const declaresName = (variable: VariableDeclaration, name: string): boolean => {
    const nameNode = variable.getNameNode();

    if (Node.isIdentifier(nameNode)) {
        return nameNode.getText() === name;
    }

    return nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).some((element) => {
        const elementName = element.getNameNode();

        return Node.isIdentifier(elementName) && elementName.getText() === name;
    });
};

/**
 * The identifiers in `node` that read a value: the trailing `.name` of a member
 * access and the key of an explicit `{ name: … }` property name a different
 * binding, so they are skipped.
 */
const valueIdentifiersIn = (node: TsNode): Identifier[] =>
    node.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
        const parent = identifier.getParent();

        return (
            !(Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) &&
            !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier)
        );
    });

/** The identifiers `node` reads a value through; `node` itself when it is a bare identifier. */
const valueIdentifiersOf = (node: TsNode): Identifier[] => (Node.isIdentifier(node) ? [node] : valueIdentifiersIn(node));

/** The outermost member/element-access (and non-null) chain that `node` heads, `node` itself when nothing extends it. */
const outermostChainOf = (node: TsNode): TsNode => {
    let outermost: TsNode = node;

    for (;;) {
        const parent = outermost.getParent();

        if (
            !(
                (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent) || Node.isNonNullExpression(parent)) &&
                parent.getExpression() === outermost
            )
        ) {
            return outermost;
        }

        outermost = parent;
    }
};

/** The `CallExpression` that invokes `chain` (`chain(…)`), or `undefined` when `chain` is only read. */
const invokedBy = (chain: TsNode): CallExpression | undefined => {
    const parent = chain.getParent();

    return Node.isCallExpression(parent) && parent.getExpression() === chain ? parent : undefined;
};

/** The `ctx.db` methods that read rows; a write returns whatever it wrote, so its arguments do not bind the row to anyone. */
const DB_READ_METHODS: ReadonlySet<string> = new Set(["find", "findFirst", "findFirstOrThrow", "findMany", "findUnique", "first", "get", "unique"]);

/** The read methods that return one row, or none. `findMany` answers a page envelope, so nothing read off it is a row's column. */
const SINGLE_ROW_READS: ReadonlySet<string> = new Set(["findFirst", "findUnique", "first", "get", "unique"]);

/** Whether `call` invokes a `ctx.db` row read (`ctx.db.files.findFirst(…)`, `ctx.db.get(…)`), not a write. */
const isDatabaseReadCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    return Node.isPropertyAccessExpression(callee) && DB_READ_METHODS.has(callee.getName()) && contextTrustPathOf(callee)?.[0] === "db";
};

/**
 * Whether `identifier` reaches the value of `within` only on some paths: the fallback of a `??` or
 * `||`, the left of a `&&`, or any part of a conditional. `args.key ?? ctx.auth.userId` is the
 * caller's key whenever one is sent, so the identity there scopes nothing; the identity on the
 * left of `ctx.auth.userId ?? "anon"` is used whenever it exists.
 */
const isAlternativeOf = (identifier: TsNode, within: TsNode): boolean => {
    for (let child = identifier, parent = identifier.getParent(); parent !== undefined && child !== within; child = parent, parent = parent.getParent()) {
        if (Node.isConditionalExpression(parent)) {
            return true;
        }

        if (Node.isBinaryExpression(parent)) {
            const operator = parent.getOperatorToken().getKind();

            if (
                (child === parent.getRight() && (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken)) ||
                (child === parent.getLeft() && operator === SyntaxKind.AmpersandAmpersandToken)
            ) {
                return true;
            }
        }
    }

    return false;
};

/** Whether `node` is the `undefined` global, not a local that shadows the name. */
const isUndefinedGlobal = (node: TsNode | undefined): boolean => {
    if (!Node.isIdentifier(node) || node.getText() !== "undefined") {
        return false;
    }

    const declaration = declarationOf(node);

    return declaration === undefined || declaration.getSourceFile().isDeclarationFile();
};

/** The operators that compare (`row === null`, `m.userId === uid`): they change nothing and yield a boolean. */
const EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.EqualsEqualsEqualsToken,
    SyntaxKind.EqualsEqualsToken,
    SyntaxKind.ExclamationEqualsEqualsToken,
    SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Whether `node` is a value no caller can choose: a literal, `undefined`, or a module-level `const` holding one.
 */
const isFixedValue = (node: TsNode): boolean => {
    const value = unwrapExpression(node) ?? node;

    if (
        Node.isStringLiteral(value) ||
        Node.isNoSubstitutionTemplateLiteral(value) ||
        Node.isNumericLiteral(value) ||
        Node.isNullLiteral(value) ||
        Node.isTrueLiteral(value) ||
        Node.isFalseLiteral(value) ||
        isUndefinedGlobal(value)
    ) {
        return true;
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;
    const initializer =
        isConstDeclaration(declaration) && Node.isSourceFile(declaration.getVariableStatement()?.getParent()) ? declaration.getInitializer() : undefined;

    return initializer !== undefined && !Node.isIdentifier(unwrapExpression(initializer)) && isFixedValue(initializer);
};

/** The outermost parentheses, `!` or type assertion around `node`, none of which change the value it passes on. */
const valueWrapperOf = (node: TsNode): TsNode => {
    let current = node;

    for (let parent = current.getParent(); ; parent = current.getParent()) {
        if (
            !(
                Node.isParenthesizedExpression(parent) ||
                Node.isNonNullExpression(parent) ||
                Node.isAsExpression(parent) ||
                Node.isSatisfiesExpression(parent) ||
                Node.isTypeAssertion(parent)
            )
        ) {
            return current;
        }

        current = parent;
    }
};

/** A function whose body can hold an identity guard: the handler itself, or a helper it calls. */
type FunctionNode = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

const isFunctionNode = (node: TsNode | undefined): node is FunctionNode =>
    Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node);

/** The innermost function containing `node`, or `undefined` at module level. */
const enclosingFunctionOf = (node: TsNode): FunctionNode | undefined => {
    const ancestor = node.getFirstAncestor((candidate) => isFunctionNode(candidate));

    return isFunctionNode(ancestor) ? ancestor : undefined;
};

/** The comparison operators besides equality: each yields a boolean whatever its operands. */
const RELATIONAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.GreaterThanEqualsToken,
    SyntaxKind.GreaterThanToken,
    SyntaxKind.InKeyword,
    SyntaxKind.InstanceOfKeyword,
    SyntaxKind.LessThanEqualsToken,
    SyntaxKind.LessThanToken,
]);

/**
 * Whether `identifier` names a value no caller chose: a ctx surface, a fixed value, a platform global (`Date`), or a
 * parameter of `callback`, the function passed as an argument that holds the predicate (`(m) => m.active && …` reads
 * the row being filtered). The handler's `args` and a helper's own parameters are none of these.
 */
const isRootedIdentifier = (identifier: Identifier, callback: FunctionNode | undefined): boolean => {
    if (contextTrustPathOf(identifier) !== undefined || isFixedValue(identifier)) {
        return true;
    }

    const declaration = declarationOf(identifier);

    if (declaration === undefined) {
        return false;
    }

    if (declaration.getSourceFile().isDeclarationFile()) {
        return true;
    }

    const parameter = Node.isParameterDeclaration(declaration) ? declaration : declaration.getFirstAncestorByKind(SyntaxKind.Parameter);

    return callback !== undefined && parameter?.getParent().compilerNode === callback.compilerNode;
};

/**
 * Whether `node`, an operand of a `&&` chain, is a required condition rather than a value the chain can yield to a
 * caller: a comparison, a negation, a boolean literal, a `&&` of such operands, or an operand that reads only values no
 * caller chose (`m.active`, `m.roles.includes("member")`). An operand reading `args` or a helper parameter
 * (`args.victim`) can become the chain's value.
 */
const isRequiredOperand = (node: TsNode, callback: FunctionNode | undefined): boolean => {
    const value = unwrapExpression(node) ?? node;

    // `!args.skip` is a boolean the caller picks, so `ctx.auth.userId && !args.skip` still yields a null identity for an
    // anonymous caller; a negation is a condition only when what it negates is one.
    if (Node.isPrefixUnaryExpression(value) && value.getOperatorToken() === SyntaxKind.ExclamationToken) {
        return isRequiredOperand(value.getOperand(), callback);
    }

    if (Node.isBinaryExpression(value)) {
        const operator = value.getOperatorToken().getKind();

        if (EQUALITY_OPERATORS.has(operator) || RELATIONAL_OPERATORS.has(operator)) {
            return true;
        }

        if (operator === SyntaxKind.AmpersandAmpersandToken) {
            return isRequiredOperand(value.getLeft(), callback) && isRequiredOperand(value.getRight(), callback);
        }
    }

    if (Node.isTrueLiteral(value) || Node.isFalseLiteral(value)) {
        return true;
    }

    return !referencesBinding(value, "args") && valueIdentifiersOf(value).every((identifier) => isRootedIdentifier(identifier, callback));
};

/** The other uses of the local `identifier`: every identifier in its file bound to the same declaration, minus the declaring name. */
const usesOfLocal = (identifier: Identifier): Identifier[] => {
    const declaration = declarationOf(identifier);

    return identifier
        .getSourceFile()
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((use) => use.getText() === identifier.getText() && declarationOf(use) === declaration)
        .filter((use) => {
            const parent = use.getParent();

            return !((Node.isVariableDeclaration(parent) || Node.isBindingElement(parent)) && parent.getNameNode() === use);
        });
};

/** The callback `node` sits in: its innermost function, when that function is passed as a call argument. */
const callbackOf = (node: TsNode): FunctionNode | undefined => {
    const enclosing = enclosingFunctionOf(node);

    if (enclosing === undefined) {
        return undefined;
    }

    const holder = valueWrapperOf(enclosing).getParent();

    if (Node.isCallExpression(holder)) {
        return holder.getArguments().includes(valueWrapperOf(enclosing)) ? enclosing : undefined;
    }

    // A predicate factored into a `const` (`const predicate = (m) => …; q.filter(predicate)`) is one hop away, as long
    // as every use of the local hands it to a call.
    const name = Node.isVariableDeclaration(holder) && isConstDeclaration(holder) ? holder.getNameNode() : undefined;
    const uses = Node.isIdentifier(name) ? usesOfLocal(name) : [];

    return uses.length > 0 &&
        uses.every((use) => {
            const wrapped = valueWrapperOf(use);
            const call = wrapped.getParent();

            return Node.isCallExpression(call) && call.getArguments().includes(wrapped);
        })
        ? enclosing
        : undefined;
};

/**
 * Whether `node` sits where only its truthiness is used: the body or a `return` of a callback (a filter or find
 * predicate), the condition of an `if`, loop or ternary, the operand of `!`, or one side of a comparison. Anywhere else
 * (a column value in `where`, a call argument, an assignment, a template) its value flows on.
 */
const isPredicatePosition = (node: TsNode): boolean => {
    const value = valueWrapperOf(node);
    const parent = value.getParent();

    if (Node.isArrowFunction(parent)) {
        return parent.getBody() === value && callbackOf(value) !== undefined;
    }

    if (Node.isReturnStatement(parent)) {
        return callbackOf(parent) !== undefined;
    }

    if (Node.isIfStatement(parent) || Node.isWhileStatement(parent) || Node.isDoStatement(parent)) {
        return parent.getExpression() === value;
    }

    if (Node.isForStatement(parent)) {
        const condition: TsNode | undefined = parent.getCondition();

        return condition === value;
    }

    if (Node.isConditionalExpression(parent)) {
        return parent.getCondition() === value;
    }

    if (Node.isPrefixUnaryExpression(parent)) {
        return parent.getOperatorToken() === SyntaxKind.ExclamationToken;
    }

    return (
        Node.isBinaryExpression(parent) &&
        (EQUALITY_OPERATORS.has(parent.getOperatorToken().getKind()) || RELATIONAL_OPERATORS.has(parent.getOperatorToken().getKind()))
    );
};

/**
 * Whether the whole `&&` chain `and` belongs to is a required condition: decided by where the chain sits, not by
 * what its operands are. As a value (`userId: ctx.auth.userId && "another-user"`, `active: uid === args.victim &&
 * true`) it yields an operand. In a predicate position (see {@link isPredicatePosition}) it is a condition, unless an
 * operand is caller-chosen (see {@link isRequiredOperand}): `ctx.auth.userId && !args.skip` lets the caller decide.
 */
const isPredicateChain = (and: TsNode): boolean => {
    let top = and;

    for (
        let parent = valueWrapperOf(top).getParent();
        Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken;
        parent = valueWrapperOf(top).getParent()
    ) {
        top = parent;
    }

    return isPredicatePosition(top) && isRequiredOperand(top, callbackOf(top));
};

/**
 * Whether `node` sits beside a caller-choosable alternative on its way up to `within`: the fallback side of a `??` or
 * `||`, a left side whose fallback is not a fixed value, or any part of a conditional. Stricter than
 * {@link isAlternativeOf}: the identity on the left of `ctx.auth.userId ?? args.victim` is null for an anonymous
 * caller, who then reads the victim's row. A fixed fallback (`ctx.auth.userId ?? "anon"`) is no one's choice. A `&&`
 * is a required condition only in a boolean predicate (`m.userId === uid && m.channelId === id`, either order; see
 * {@link isPredicateChain}); a `&&` with a caller-chosen operand (`uid && args.victim`) yields that value instead.
 */
const hasAlternativeWithin = (node: TsNode, within: TsNode): boolean => {
    for (let child = node, parent = node.getParent(); parent !== undefined && child !== within; child = parent, parent = parent.getParent()) {
        if (Node.isConditionalExpression(parent)) {
            return true;
        }

        const operator = Node.isBinaryExpression(parent) ? parent.getOperatorToken().getKind() : undefined;

        if (Node.isBinaryExpression(parent) && (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken)) {
            if (child !== parent.getLeft() || !isFixedValue(parent.getRight())) {
                return true;
            }
        } else if (Node.isBinaryExpression(parent) && operator === SyntaxKind.AmpersandAmpersandToken && !isPredicateChain(parent)) {
            return true;
        }
    }

    return false;
};

/** Whether `comparison` is the predicate a callback returns as a whole, alone or in a `&&` chain. */
const isReturnedPredicate = (comparison: TsNode): boolean => {
    let current = valueWrapperOf(comparison);

    for (
        let parent = current.getParent();
        Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken;
        parent = current.getParent()
    ) {
        current = valueWrapperOf(parent);
    }

    const parent = current.getParent();

    return (Node.isArrowFunction(parent) && parent.getBody() === current) || Node.isReturnStatement(parent);
};

/** The `ctx.auth` member that names the caller; `getIdentity` is a method shared by every caller. */
const CALLER_ID_MEMBER = "userId";

/** Whether a ctx path is the caller's id itself, `["auth", "userId"]`, and not another `ctx.auth` field. */
const isCallerIdPath = (path: ReadonlyArray<string> | undefined): boolean => path?.length === 2 && path[0] === "auth" && path[1] === CALLER_ID_MEMBER;

/** `node` without the parentheses, `await`, `!` and type assertions around it, none of which change the value. */
const strippedValue = (node: TsNode): TsNode => {
    let current = node;

    for (;;) {
        const next = Node.isNonNullExpression(current) || Node.isAwaitExpression(current) ? current.getExpression() : unwrapExpression(current);

        if (next === undefined || next === current) {
            return current;
        }

        current = next;
    }
};

/** Whether `value` is the caller's id itself (`ctx.auth.userId`, or a local bound to it), not merely an expression that mentions it. */
const isCallerId = (value: TsNode): boolean => isCallerIdPath(contextTrustPathOf(strippedValue(value)));

/** The `where` operators that match rows other than the value they are given, or the value's complement. */
const NON_MATCHING_OPERATORS: ReadonlySet<string> = new Set(["contains", "gt", "gte", "isNull", "lt", "lte", "ne", "neq", "not", "notIn"]);

/** The query keys whose branches admit rows the identity does not pin: `NOT` negates, an `OR` arm adds others. */
const UNPINNING_KEYS: ReadonlySet<string> = new Set(["NOT", "not", "OR"]);

/** Whether a property on the way up from `node` to its query call is a `NOT` or `OR` branch. */
const sitsInUnpinningBranch = (node: TsNode): boolean => {
    for (let ancestor = node.getParent(); ancestor !== undefined && !Node.isCallExpression(ancestor); ancestor = ancestor.getParent()) {
        const key = Node.isPropertyAssignment(ancestor) ? staticPropertyName(ancestor.getNameNode()) : undefined;

        if (key !== undefined && UNPINNING_KEYS.has(key)) {
            return true;
        }
    }

    return false;
};

const isAssignmentOperator = (kind: SyntaxKind): boolean => kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;

/**
 * Whether `node` is written: the target of an assignment, including from inside a destructuring pattern
 * (`({ a: row.ownerId } = x)`, `[row.ownerId] = x`), a `for…of` / `for…in` target, or the operand of
 * `delete`, `++` or `--`.
 */
const isWriteTarget = (node: TsNode): boolean => {
    let current = node;
    let parent = current.getParent();

    // Climb out of any pattern the node sits in as a target, and out of the assertions a target may wear (`(id as
    // string) = …`, `id! = …`); a value position in an object literal climbs too, which is harmless: it only ends in a
    // write when that literal is itself an assignment target.
    while (
        Node.isParenthesizedExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isSatisfiesExpression(parent) ||
        Node.isNonNullExpression(parent) ||
        Node.isTypeAssertion(parent) ||
        Node.isArrayLiteralExpression(parent) ||
        Node.isObjectLiteralExpression(parent) ||
        Node.isSpreadElement(parent) ||
        Node.isSpreadAssignment(parent) ||
        Node.isShorthandPropertyAssignment(parent) ||
        (Node.isPropertyAssignment(parent) && parent.getNameNode() !== current)
    ) {
        current = parent;
        parent = current.getParent();
    }

    if (Node.isBinaryExpression(parent)) {
        return parent.getLeft() === current && isAssignmentOperator(parent.getOperatorToken().getKind());
    }

    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) {
        return parent.getInitializer() === current;
    }

    if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
        const operator = parent.getOperatorToken();

        return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
    }

    return Node.isDeleteExpression(parent);
};

/** A path of names read off the row; an `undefined` segment is a computed key, which may be any name. */
type RowPath = ReadonlyArray<string | undefined>;

/** Whether `path` and `other` may name the same value, or one an object holding the other. */
const overlaps = (path: RowPath, other: RowPath): boolean =>
    path.every((segment, index) => index >= other.length || segment === undefined || other[index] === undefined || segment === other[index]);

/** Whether `path` names an object that holds `other`, rather than `other` itself or a value below it. */
const holds = (path: RowPath, other: RowPath): boolean => path.length < other.length && overlaps(path, other);

/**
 * The longest property/element access chain `use` heads, through value-preserving wrappers, and the names it reads
 * (`undefined` for a computed key).
 */
const accessChainFrom = (use: Identifier): { node: TsNode; path: (string | undefined)[] } => {
    const path: (string | undefined)[] = [];
    let node: TsNode = valueWrapperOf(use);

    for (let parent = node.getParent(); ; parent = node.getParent()) {
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
            path.push(parent.getName());
        } else if (Node.isElementAccessExpression(parent) && parent.getExpression() === node) {
            const argument = unwrapExpression(parent.getArgumentExpression());

            path.push(Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument) ? argument.getLiteralValue() : undefined);
        } else {
            return { node, path };
        }

        node = valueWrapperOf(parent);
    }
};

/** Whether `node` is the callee of the call that is its parent (`row.save()`), so the object it is read off runs as `this`. */
const isInvoked = (node: TsNode): boolean => {
    const parent = node.getParent();

    return Node.isCallExpression(parent) && parent.getExpression() === node;
};

/** Whether `node` only tests an object (`!row`, `row === null`, `typeof row`), which cannot change it. */
const isTestOf = (node: TsNode): boolean => {
    const parent = node.getParent();

    if (Node.isBinaryExpression(parent)) {
        const operator = parent.getOperatorToken().getKind();
        const other = unwrapExpression(parent.getLeft() === node ? parent.getRight() : parent.getLeft());

        // A loose comparison with anything but `null` / `undefined` converts the object, running its `valueOf` or
        // `toString`, which can write it (`row == 1` after `row.valueOf = function () { this.key = … }`).
        return (
            operator === SyntaxKind.EqualsEqualsEqualsToken ||
            operator === SyntaxKind.ExclamationEqualsEqualsToken ||
            ((operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken) &&
                (Node.isNullLiteral(other) || isUndefinedGlobal(other)))
        );
    }

    return (Node.isPrefixUnaryExpression(parent) && parent.getOperatorToken() === SyntaxKind.ExclamationToken) || Node.isTypeOfExpression(parent);
};

/**
 * Whether `node`, standing for the row at `path`, only tests the row itself (`!row`, `row === null`): that reads no
 * field. A field on either side of a comparison (`m.channelId === row.channelId`) is one the guard depends on.
 */
const isBareRowTest = (node: TsNode, path: RowPath): boolean => path.length === 0 && isTestOf(node);

/**
 * Whether an object at `path` holding the guarded values at `heldPaths`, used as `node`, only has them read: tested,
 * returned from `owner` (the function that declares the binding), or copied by a spread or a destructuring. Any call
 * is an escape, `JSON.stringify` included: it runs the row's `toJSON` and its replacer, either of which can write. A copy is shallow, so it is
 * read-only only while every held value sits directly on the object: spreading `row` for a key at `row.meta.key`
 * shares `row.meta`, and `copy.meta.key = …` then changes the key unseen.
 */
const isReadOnlyHolderUse = (node: TsNode, path: RowPath, heldPaths: ReadonlyArray<RowPath>, owner: FunctionNode | undefined): boolean => {
    const parent = node.getParent();
    // A declaration whose name is a pattern can only hold `node` as its initializer.
    const isCopy = Node.isSpreadAssignment(parent) || (Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode()));

    if (isCopy) {
        return heldPaths.every((held) => held.length === path.length + 1);
    }

    // A `return` ends the function that owns the binding, so nothing after it there runs; one from a nested function
    // hands its caller an alias this check never sees.
    const returnsFromOwner = Node.isReturnStatement(parent) && owner !== undefined && enclosingFunctionOf(parent)?.compilerNode === owner.compilerNode;

    return isTestOf(node) || returnsFromOwner;
};

/**
 * Whether `use`, a reference to the guarded row, leaves every value at `guardedPaths` (the key, and each field the
 * guard read) as the guard saw it. A write that may reach one (`row.key = …`, `row.channelId = args.channelId`,
 * `({ key: row.key } = args)`, `delete row.key`) changes it, and so can any code handed an object holding one: a call
 * argument (`Object.assign(row, args)`, `mutate(row)`), a method invoked on it, or an alias. A holder may still be
 * read without being handed on (see {@link isReadOnlyHolderUse}). `prefix` is the row path `use` itself stands for: `[]`
 * for the row, `["meta"]` for a helper parameter that received `row.meta`.
 */
const keepsGuardedValues = (use: Identifier, guardedPaths: ReadonlyArray<RowPath>, prefix: RowPath = []): boolean => {
    const { node, path: chainPath } = accessChainFrom(use);
    const path = [...prefix, ...chainPath];

    // Assigning the binding itself (`channelId = "general"` in a helper) rebinds a local; it writes nothing into the
    // row. Whether that may run before the check is judged where the guard is found.
    if (isWriteTarget(node)) {
        return chainPath.length === 0 || !guardedPaths.some((guardedPath) => overlaps(path, guardedPath));
    }

    // A method invoked on a holder (`row.save()`) runs with the holder as `this`; one on a guarded value itself cannot repoint it.
    if (isInvoked(node)) {
        const holder = path.slice(0, -1);

        return chainPath.length === 0 || !guardedPaths.some((guardedPath) => holds(holder, guardedPath));
    }

    const heldPaths = guardedPaths.filter((guardedPath) => holds(path, guardedPath));

    const declaration = declarationOf(use);

    return heldPaths.length === 0 || isReadOnlyHolderUse(node, path, heldPaths, declaration === undefined ? undefined : enclosingFunctionOf(declaration));
};

/**
 * Whether a later member of `object` can replace `property` at runtime: a spread, the same key written
 * again, or a computed key whose name is only known at runtime (`[args.field]: …`).
 */
const isOverriddenLater = (object: ObjectLiteralExpression, property: ObjectLiteralElementLike): boolean => {
    const members = object.getProperties();
    const key = Node.isSpreadAssignment(property) ? undefined : propertyKeyName(property);

    return members.slice(members.indexOf(property) + 1).some((later) => {
        if (Node.isSpreadAssignment(later)) {
            return true;
        }

        const laterKey = staticPropertyName(later.getNameNode());

        return laterKey === undefined || laterKey === key;
    });
};

/**
 * Whether a member on the way from `node` up to its query call or declaration can be replaced at runtime: a later
 * spread, duplicate key or computed key in the same object literal (`{ userId: uid, ...args.where }`).
 */
const isOverriddenOnTheWay = (node: TsNode): boolean => {
    for (
        let current: TsNode | undefined = node;
        current !== undefined && !Node.isCallExpression(current) && !Node.isVariableDeclaration(current) && !isFunctionNode(current);
        current = current.getParent()
    ) {
        const object = current.getParent();

        if (
            (Node.isPropertyAssignment(current) || Node.isShorthandPropertyAssignment(current)) &&
            Node.isObjectLiteralExpression(object) &&
            isOverriddenLater(object, current)
        ) {
            return true;
        }
    }

    return false;
};

/** Which calls count as row reads: the handler's `ctx.db` reads, or a helper's reads through its verified ctx parameter. */
type ReadCallTest = (call: CallExpression) => boolean;

/** Whether `use`, past its wrappers, is passed straight to a row read as an argument. */
const isReadArgument = (use: TsNode, isRead: ReadCallTest): boolean => {
    const wrapped = valueWrapperOf(use);
    const call = wrapped.getParent();

    return Node.isCallExpression(call) && call.getArguments().includes(wrapped) && isRead(call);
};

/**
 * Whether `query` is passed as an argument of a row read: written inline, or held by a `const` local
 * (`const query = { where: … }; ctx.db.members.findFirst(query)`) whose every use is such an argument. Used
 * anywhere else (`with: { members: query }`), the local is no query of the row the read returns.
 */
const isReadQueryArgument = (query: TsNode, isRead: ReadCallTest = isDatabaseReadCall): boolean => {
    const wrapped = valueWrapperOf(query);
    const holder = wrapped.getParent();

    if (Node.isVariableDeclaration(holder) && isConstDeclaration(holder)) {
        const initializer: TsNode | undefined = holder.getInitializer();
        const name = holder.getNameNode();
        const uses = Node.isIdentifier(name) && initializer === wrapped ? usesOfLocal(name) : [];

        return uses.length > 0 && uses.every((use) => isReadArgument(use, isRead));
    }

    return isReadArgument(wrapped, isRead);
};

/**
 * Whether `object` is the read's own top-level `where`: the `where` of a `ctx.db` read's query argument, an `AND`
 * element of one, or a local's initializer (`const filter = { … }`), judged at each of its uses. A `where` under
 * `with` / `include` or any other nested query constrains related rows, not the row the read returns.
 */
const isTopLevelWhere = (object: TsNode, isRead: ReadCallTest = isDatabaseReadCall): boolean => {
    const wrapped = valueWrapperOf(object);
    const holder = wrapped.getParent();

    if (Node.isPropertyAssignment(holder)) {
        return staticPropertyName(holder.getNameNode()) === "where" && isReadQueryArgument(holder.getParent(), isRead);
    }

    if (Node.isArrayLiteralExpression(holder)) {
        const branches = valueWrapperOf(holder).getParent();

        return Node.isPropertyAssignment(branches) && staticPropertyName(branches.getNameNode()) === "AND" && isTopLevelWhere(branches.getParent(), isRead);
    }

    if (Node.isVariableDeclaration(holder)) {
        const initializer: TsNode | undefined = holder.getInitializer();

        return initializer === wrapped;
    }

    return false;
};

/**
 * Whether `property` constrains the row a read returns: a column of the read's top-level `where`, or an `eq` / `in`
 * operator directly under such a column. A relation filter inside `where` (`members: { userId: uid }`) constrains
 * other rows, as #1612 settled for owned-row columns.
 */
const isTopLevelWhereMember = (property: TsNode, isRead: ReadCallTest = isDatabaseReadCall): boolean => {
    const object = property.getParent();

    if (!Node.isObjectLiteralExpression(object) || !(Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))) {
        return false;
    }

    const key = staticPropertyName(property.getNameNode());

    if (key === "eq" || key === "in") {
        const column = valueWrapperOf(object).getParent();

        return Node.isPropertyAssignment(column) && isTopLevelWhere(column.getParent(), isRead);
    }

    return isTopLevelWhere(object, isRead);
};

/**
 * Whether `list` holds nothing but the caller's id and is the value of an `in` with no `NOT` or `OR` above it. A list
 * factored into a never-repointed local (`const ownerIds = [uid]`) is judged at every place the local is used.
 */
const isCallerOnlyInList = (list: TsNode): boolean => {
    if (!Node.isArrayLiteralExpression(list) || !list.getElements().every((element) => isCallerId(element))) {
        return false;
    }

    const holder = valueWrapperOf(list).getParent();
    const name = Node.isVariableDeclaration(holder) ? holder.getNameNode() : undefined;
    const isLocal = Node.isIdentifier(name) && trustedInitializerOf(name) !== undefined;
    const placements = isLocal ? usesOfLocal(name) : [list];

    return (
        placements.length > 0 &&
        placements.every((placement) => {
            const property = valueWrapperOf(placement).getParent();

            return (
                Node.isPropertyAssignment(property) &&
                staticPropertyName(property.getNameNode()) === "in" &&
                !sitsInUnpinningBranch(property) &&
                isTopLevelWhereMember(property) &&
                !isOverriddenOnTheWay(property)
            );
        })
    );
};

/**
 * Whether anything in `scope` assigns the binding `declaration` makes, by symbol. Scanned here rather than with
 * `isReassignedBinding`, which takes a parameter inside a `const x = q.filter(…)` initializer for a `const` binding.
 */
const isAssignedWithin = (scope: TsNode, declaration: TsNode): boolean =>
    scope
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((identifier) => isWriteTarget(identifier) && declarationOf(identifier)?.compilerNode === declaration.compilerNode);

/**
 * Whether `binding` takes a column the code names: an identifier or literal key, or a computed key that is a string
 * literal or a module constant. `{ [args.field]: value }` lets the caller choose the column.
 */
const hasStaticKey = (binding: BindingElement): boolean => {
    const key = binding.getPropertyNameNode();

    return !Node.isComputedPropertyName(key) || isFixedValue(key.getExpression());
};

/**
 * Whether `element` and every element enclosing it in its parameter pattern have a static key and no default, and
 * nothing in the callback assigns it (see {@link isAssignedWithin}).
 */
const isUndefaultedRowBinding = (element: BindingElement): boolean =>
    !isAssignedWithin(element.getFirstAncestorByKind(SyntaxKind.Parameter)?.getParent() ?? element, element) &&
    [element, ...element.getAncestors().filter((ancestor) => Node.isBindingElement(ancestor))].every(
        (binding) =>
            Node.isBindingElement(binding) && binding.getInitializer() === undefined && binding.getDotDotDotToken() === undefined && hasStaticKey(binding),
    );

/**
 * Whether every use of the row binding `declaration` in `callback` leaves the field `root` reads (`m.userId`) as the
 * row holds it: no write to it or an object holding it (`m.userId = uid`, `delete m.userId`, `({ userId: m.userId } =
 * x)`), no method on a holder, and no holder handed to a call (`mutate(m)`). A write to another field is fine.
 */
const keepsRowField = (root: Identifier, declaration: TsNode | undefined, callback: TsNode): boolean => {
    const fieldPath = accessChainFrom(root).path;

    return callback
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((identifier) => identifier.getParent() !== declaration && declarationOf(identifier)?.compilerNode === declaration?.compilerNode)
        .every((use) => keepsGuardedValues(use, [fieldPath]));
};

/**
 * Whether `node` reads a field of the row a filter callback is handed (`m.userId` in `(m) => …`): only then does an
 * identity equality pin the match. Against an args value, a constant or another identity (`uid === args.victim`) it is
 * a check that does not depend on the row at all.
 */
const isFilteredRowField = (node: TsNode, comparison: TsNode): boolean => {
    const field = unwrapExpression(node) ?? node;
    const isAccess = Node.isPropertyAccessExpression(field) || Node.isElementAccessExpression(field);
    const root = isAccess ? memberAccessRootIdentifier(field) : field;
    const declaration = Node.isIdentifier(root) ? declarationOf(root) : undefined;
    const callback: TsNode | undefined = callbackOf(comparison);
    let owner: TsNode | undefined;

    // The row parameter itself is a field only through an access (`m.userId`), and only while the callback never
    // repoints it (`m = { ...m, userId: uid }`); a name destructured from it (`({ userId }) => userId === uid`) is one
    // when its key is static, no default can replace it and nothing reassigns it.
    if (Node.isParameterDeclaration(declaration) && isAccess && !isAssignedWithin(declaration.getParent(), declaration)) {
        owner = declaration.getParent();
    } else if (Node.isBindingElement(declaration) && isUndefaultedRowBinding(declaration)) {
        owner = declaration.getFirstAncestorByKind(SyntaxKind.Parameter)?.getParent();
    }

    return owner !== undefined && owner === callback && Node.isIdentifier(root) && keepsRowField(root, declaration, owner);
};

/**
 * Whether `value`, a caller identity past its wrappers, matches the caller where it stands: a column value or
 * `{ eq: … }` (not `ne`, `notIn` or another non-matching operator), an `in` list holding nothing but the caller's id,
 * an argument of a call that is no negating comparison (`ctx.db.users.get(uid)`, `q.eq("userId", uid)`), or one side
 * of an `===` / `==` a filter callback returns. A `NOT` or `OR` branch above it unpins the match.
 */
const matchesCallerAt = (value: TsNode, isRead: ReadCallTest): boolean => {
    const parent = value.getParent();

    if (Node.isArrayLiteralExpression(parent)) {
        return isCallerOnlyInList(parent);
    }

    if (Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent)) {
        const key = staticPropertyName(parent.getNameNode());
        const initializer: TsNode | undefined = Node.isPropertyAssignment(parent) ? parent.getInitializer() : value;
        const isValue = initializer === value;

        return (
            isValue &&
            key !== undefined &&
            !NON_MATCHING_OPERATORS.has(key) &&
            !UNPINNING_KEYS.has(key) &&
            !sitsInUnpinningBranch(parent) &&
            isTopLevelWhereMember(parent, isRead) &&
            !isOverriddenOnTheWay(parent)
        );
    }

    // Only a query takes the identity as a match: an `eq` predicate (`q.eq("userId", uid)`) or a `ctx.db` read
    // (`ctx.db.users.get(uid)`). Any other call (`Boolean(uid)`, a helper) yields something else; `String(uid)` is
    // walked through before this point.
    if (Node.isCallExpression(parent)) {
        const callee = parent.getExpression();
        const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
        const isQuery = method === "eq" || isRead(parent);

        return parent.getArguments().includes(value) && isQuery;
    }

    if (!Node.isBinaryExpression(parent)) {
        return false;
    }

    const operator = parent.getOperatorToken().getKind();
    const other = parent.getLeft() === value ? parent.getRight() : parent.getLeft();

    return (
        (operator === SyntaxKind.EqualsEqualsEqualsToken || operator === SyntaxKind.EqualsEqualsToken) &&
        isReturnedPredicate(parent) &&
        isFilteredRowField(other, parent)
    );
};

/**
 * Whether `call` hands back its sole argument `value` unchanged as a key: the platform's `String(value)`. The walk
 * continues through it, so the constraint around the call (`ne`, `NOT`, `!==`) still decides.
 */
const isValuePreservingCall = (call: TsNode, value: TsNode): boolean => {
    if (!Node.isCallExpression(call)) {
        return false;
    }

    const callee = call.getExpression();
    const [only, ...rest] = call.getArguments();
    const declaration = Node.isIdentifier(callee) && callee.getText() === "String" ? declarationOf(callee) : undefined;

    return only === value && rest.length === 0 && declaration?.getSourceFile().isDeclarationFile() === true;
};

/**
 * Whether the identity read `node` decides which rows a read matches: it is, past wrappers and a fixed fallback, the
 * value of a column in a query object (`ownerId: uid`, `{ eq: uid }`), an argument of a call (`ctx.db.users.get(uid)`,
 * `q.eq("userId", uid)`), or one side of a comparison a filter callback returns. Nested in another column's value
 * expression (`active: uid === args.victim && true`) it decides only that value, not the match.
 */
const constrainsMatch = (node: TsNode, isRead: ReadCallTest = isDatabaseReadCall): boolean => {
    let current = outermostChainOf(node);

    for (let parent = current.getParent(); parent !== undefined; parent = current.getParent()) {
        const isWrapper =
            Node.isParenthesizedExpression(parent) ||
            Node.isNonNullExpression(parent) ||
            Node.isAsExpression(parent) ||
            Node.isSatisfiesExpression(parent) ||
            Node.isTypeAssertion(parent) ||
            Node.isAwaitExpression(parent);
        const operator = Node.isBinaryExpression(parent) ? parent.getOperatorToken().getKind() : undefined;
        const isFixedFallback =
            Node.isBinaryExpression(parent) &&
            (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) &&
            parent.getLeft() === current &&
            isFixedValue(parent.getRight());

        if (!isWrapper && !isFixedFallback && !isValuePreservingCall(parent, current)) {
            break;
        }

        current = parent;
    }

    return matchesCallerAt(current, isRead);
};

/**
 * Whether `use`, a query-object local, is a whole filter: the `where` of a query, an `AND` element, or a `ctx.db` read's
 * own argument, with no `NOT` or `OR` above it. Any other use (a spread, a negation, a call) fails closed.
 */
const isWholeFilterUse = (use: TsNode): boolean => {
    const wrapped = valueWrapperOf(use);
    const parent = wrapped.getParent();

    if (Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent)) {
        return (
            staticPropertyName(parent.getNameNode()) === "where" &&
            !sitsInUnpinningBranch(parent) &&
            isReadQueryArgument(parent.getParent()) &&
            !isOverriddenOnTheWay(parent)
        );
    }

    if (Node.isArrayLiteralExpression(parent)) {
        const branches = valueWrapperOf(parent).getParent();

        return (
            Node.isPropertyAssignment(branches) &&
            staticPropertyName(branches.getNameNode()) === "AND" &&
            !sitsInUnpinningBranch(branches) &&
            isTopLevelWhere(branches.getParent()) &&
            !isOverriddenOnTheWay(branches)
        );
    }

    return Node.isCallExpression(parent) && parent.getArguments().includes(wrapped) && isDatabaseReadCall(parent);
};

/**
 * The expressions that can become the value of `node`, past wrappers: the last operand of a comma, each branch of a
 * conditional, each side of `??`, `||` or `&&`. `(await ownedRead(), args.victimId)` evaluates to `args.victimId`.
 */
const valueExpressionsOf = (node: TsNode): TsNode[] => {
    const value = strippedValue(node);

    if (Node.isConditionalExpression(value)) {
        return [...valueExpressionsOf(value.getWhenTrue()), ...valueExpressionsOf(value.getWhenFalse())];
    }

    if (!Node.isBinaryExpression(value)) {
        return [value];
    }

    const operator = value.getOperatorToken().getKind();

    if (operator === SyntaxKind.CommaToken) {
        return valueExpressionsOf(value.getRight());
    }

    return operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken || operator === SyntaxKind.AmpersandAmpersandToken
        ? [...valueExpressionsOf(value.getLeft()), ...valueExpressionsOf(value.getRight())]
        : [value];
};

/**
 * Whether `argument` names the caller's identity, directly or through a local whose initializer does,
 * with no alternative beside it: `ownerId: args.ownerId ?? ctx.auth.userId` selects the caller's row only when
 * nothing is sent, and `ownerId: ctx.auth.userId ?? args.ownerId` selects the caller's choice for an anonymous one.
 */
const readsCallerIdentity = (argument: TsNode): boolean =>
    valueIdentifiersOf(argument).some((identifier) => {
        if (hasAlternativeWithin(identifier, argument)) {
            return false;
        }

        // Only the caller's id names the caller: `ctx.auth.role` or `ctx.auth.orgId` is shared by everyone who holds it.
        if (isCallerId(outermostChainOf(identifier))) {
            return constrainsMatch(identifier);
        }

        const initializer = trustedInitializerOf(identifier);
        const values = initializer === undefined ? [] : valueExpressionsOf(initializer);

        // A local is judged by what becomes its value: the last operand of a comma, each branch of a conditional or
        // fallback. Every one an identity makes it an alias (`const uid = ctx.auth.userId`), placed where it is used.
        if (values.length > 0 && values.every((value) => isCallerId(value))) {
            return constrainsMatch(identifier);
        }

        // A single query object, list or filter predicate (`const filter = { ownerId: uid }`, `const ids = [uid]`,
        // `const predicate = (m) => …`) is placed inside itself. A query object must also be used only as a whole
        // filter: `where: { NOT: filter }` negates it however its own initializer reads.
        const [only] = values;
        const isQueryObject = Node.isObjectLiteralExpression(only);
        const isPlacedInside = isQueryObject || Node.isArrayLiteralExpression(only) || Node.isArrowFunction(only) || Node.isFunctionExpression(only);

        if (
            values.length !== 1 ||
            only === undefined ||
            !isPlacedInside ||
            (isQueryObject && !(Node.isIdentifier(identifier) && usesOfLocal(identifier).every((use) => isWholeFilterUse(use))))
        ) {
            return false;
        }

        return valueIdentifiersOf(only).some((inner) => isCallerId(outermostChainOf(inner)) && !hasAlternativeWithin(inner, only) && constrainsMatch(inner));
    });

/**
 * Whether a database read is bound to the caller: one of its arguments names the
 * caller's identity, directly or through a local whose initializer does
 * (`ctx.db.files.findFirst({ where: { ownerId: uid } })` with `uid = ctx.auth.userId`).
 * A read keyed by a caller-supplied id (`ctx.db.get("files", args.id)`) is not: the
 * row it returns is whichever one the caller pointed at, so a key read off it is
 * caller-chosen.
 */
const isIdentityBoundRead = (call: CallExpression): boolean =>
    isDatabaseReadCall(call) && call.getArguments().some((argument) => readsCallerIdentity(argument));

/** Whether a `ctx.db` call lies between `identifier` and `within`, counting `within` itself and nothing above it. */
const insideDatabaseCallWithin = (identifier: TsNode, within: TsNode): boolean => {
    for (let ancestor = identifier.getParent(); ancestor !== undefined; ancestor = ancestor.getParent()) {
        if (Node.isCallExpression(ancestor) && contextTrustPathOf(ancestor.getExpression())?.[0] === "db") {
            return true;
        }

        if (ancestor === within) {
            return false;
        }
    }

    return false;
};

/** Fields that name the row itself, so they differ for every caller that owns one. */
const ROW_ID_FIELDS: ReadonlySet<string> = new Set(["_id", "id"]);

/**
 * The field read off a row `source` yields, through any `await`, parentheses, `!` or type assertion
 * (`(await ctx.db.files.findFirst(…)).key`, `row.key`), and the expression that reads it.
 * `field` is `undefined` when the row itself is used.
 */
const rowFieldReadOf = (source: TsNode): { field: string | undefined; read: TsNode } => {
    let current = source;

    for (let parent = current.getParent(); ; parent = current.getParent()) {
        if (
            Node.isAwaitExpression(parent) ||
            Node.isParenthesizedExpression(parent) ||
            Node.isNonNullExpression(parent) ||
            Node.isAsExpression(parent) ||
            Node.isSatisfiesExpression(parent) ||
            Node.isTypeAssertion(parent)
        ) {
            current = parent;
            continue;
        }

        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
            return { field: parent.getName(), read: parent };
        }

        if (Node.isElementAccessExpression(parent) && parent.getExpression() === current) {
            const argument = unwrapExpression(parent.getArgumentExpression());
            const isStaticKey = Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument);

            return { field: isStaticKey ? argument.getLiteralValue() : undefined, read: parent };
        }

        return { field: undefined, read: current };
    }
};

/** The value a `key: value` or shorthand `{ key }` property holds; `undefined` for any other member. */
const propertyValueOf = (property: TsNode | undefined): TsNode | undefined => {
    if (Node.isPropertyAssignment(property)) {
        return property.getInitializer();
    }

    return Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : undefined;
};

/** Whether `node`, past any value-preserving wrapper, is passed straight to a `ctx.db` row read as an argument. */
const isDatabaseReadArgument = (node: TsNode): boolean => {
    const call = valueWrapperOf(node).getParent();

    return Node.isCallExpression(call) && isDatabaseReadCall(call) && call.getArguments().includes(valueWrapperOf(node));
};

/**
 * Whether the local `identifier` is only ever handed to a `ctx.db` read: as the query object itself, or as the
 * `where` of a query object written inline in that call. Any other use (`filter.ownerId = …`, `Object.assign`,
 * `{ value: filter }`) can change or alias the object, so its initializer no longer says what it holds.
 */
const isOnlyQueried = (identifier: Identifier): boolean =>
    usesOfLocal(identifier).every((use) => {
        if (isDatabaseReadArgument(use)) {
            return true;
        }

        const wrapped = valueWrapperOf(use);
        const property = wrapped.getParent();
        const holder = property?.getParent();
        const isWhere =
            (Node.isPropertyAssignment(property) && property.getNameNode() !== wrapped && propertyKeyName(property) === "where") ||
            (Node.isShorthandPropertyAssignment(property) && property.getName() === "where");

        return isWhere && holder !== undefined && isDatabaseReadArgument(holder);
    });

/** The object literal `node` is, written inline or held by a local that is never repointed and only handed to a `ctx.db` read. */
const objectLiteralOf = (node: TsNode | undefined): ObjectLiteralExpression | undefined => {
    const value = unwrapExpression(node);

    if (Node.isObjectLiteralExpression(value)) {
        return value;
    }

    const initializer = Node.isIdentifier(value) && isOnlyQueried(value) ? unwrapExpression(trustedInitializerOf(value)) : undefined;

    return Node.isObjectLiteralExpression(initializer) ? initializer : undefined;
};

/** Whether a predicate `value` equates its column to the caller: the caller id itself, or `{ eq: callerId }`. */
const equatesToCaller = (value: TsNode): boolean => {
    const operand = unwrapExpression(value) ?? value;

    if (!Node.isObjectLiteralExpression(operand)) {
        return isCallerId(value);
    }

    const [only, ...rest] = operand.getProperties();
    const eq = rest.length === 0 && Node.isPropertyAssignment(only) && propertyKeyName(only) === "eq" ? only.getInitializer() : undefined;

    return eq !== undefined && isCallerId(eq);
};

/** Whether `object` has a member that runs code when the query is evaluated (a getter, setter or method), which can rewrite it. */
const hasExecutableMember = (object: ObjectLiteralExpression): boolean =>
    object.getProperties().some((member) => Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member) || Node.isMethodDeclaration(member));

/**
 * Whether the `where` object `filter` pins `field` (any column when `undefined`) to the caller on every row it
 * admits: directly, or in any `AND` branch. A filter with a getter or method pins nothing: evaluating it can
 * rewrite the owner predicate before the query reads it.
 */
const pinsFieldToCaller = (filter: ObjectLiteralExpression, field: string | undefined): boolean =>
    !hasExecutableMember(filter) &&
    filter.getProperties().some((property) => {
        const value = propertyValueOf(property);

        if (value === undefined || Node.isSpreadAssignment(property) || isOverriddenLater(filter, property)) {
            return false;
        }

        // A computed column (`[args.field]: uid`) lets the caller pick which column the caller id is matched against.
        const key = staticPropertyName(property.getNameNode());

        if (key === undefined) {
            return false;
        }

        if (key === "AND") {
            const branches = unwrapExpression(value);

            return (
                Node.isArrayLiteralExpression(branches) &&
                branches.getElements().some((branch) => {
                    const object = objectLiteralOf(branch);

                    return object !== undefined && pinsFieldToCaller(object, field);
                })
            );
        }

        return (field === undefined || key === field) && equatesToCaller(value);
    });

/** Whether the query object `argument` has a `where` that pins `field` (any column when `undefined`) to the caller. */
const pinsReadToCaller = (argument: TsNode, field: string | undefined): boolean => {
    const queryArgs = objectLiteralOf(argument);
    const where = queryArgs === undefined ? undefined : findObjectProperty(queryArgs, "where");
    // `{ where: …, ...args.query }` can replace the whole filter.
    const filter =
        queryArgs === undefined || where === undefined || hasExecutableMember(queryArgs) || isOverriddenLater(queryArgs, where)
            ? undefined
            : objectLiteralOf(propertyValueOf(where));

    return filter !== undefined && pinsFieldToCaller(filter, field);
};

/**
 * Whether every row `read` can return is the caller's: fetched by the caller's id (`ctx.db.users.get(ctx.auth.userId)`),
 * or through a `where` that pins some column to the caller and that no later spread or computed key can replace. A
 * spread before `where` is harmless: the `where` written after it wins.
 */
const isPinnedToCaller = (read: CallExpression): boolean =>
    read.getArguments().some((argument) => isCallerId(argument) || pinsReadToCaller(argument, undefined));

/**
 * Whether `field` of a row returned by the identity-bound `read` differs per caller: the row's
 * id, or a column the read matched against the caller (`ownerId` in `where: { ownerId:
 * ctx.auth.userId }`). Any other column (`me.plan`, `me.locale`) can hold the same value for
 * every caller, so it scopes a key no more than `ctx.env.PREFIX` does.
 */
const isIdentityField = (read: CallExpression, field: string | undefined): boolean => {
    if (field === undefined) {
        return false;
    }

    // The row's own id is the caller's only when the read is pinned to the caller on every path: fetched by the
    // caller's id (`ctx.db.users.get(ctx.auth.userId)`), or through a `where` that pins some column to the caller.
    // A caller id in one `OR` arm, or a query a spread or computed key can rewrite, selects rows the caller chose.
    if (ROW_ID_FIELDS.has(field)) {
        return isPinnedToCaller(read);
    }

    // Only a predicate of the read's own `where`, directly or in an `AND` branch, binds every returned row: one
    // inside a relation filter (`where: { author: { ownerId: uid } }`) constrains another row, and one in an
    // `OR` arm a single branch.
    return read.getArguments().some((argument) => pinsReadToCaller(argument, field));
};

/** The columns a `select` projection always keeps, whatever it lists. */
const SELECT_SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/**
 * Whether the row `read` returns still carries `field`: no `select`, or a `select` of literal names that lists it. A
 * projected-away column reads `undefined` for every caller, so it scopes nothing; a `select` that is not a literal list
 * keeps only the system fields as far as this can tell. A spread (`...args.query`) or computed key can supply a
 * `select` of the caller's choosing, so with no literal `select` after it the projection is unknown.
 */
const keepsColumn = (read: CallExpression, field: string): boolean =>
    SELECT_SYSTEM_FIELDS.has(field) ||
    read.getArguments().every((argument) => {
        const query = objectLiteralOf(argument);

        if (query === undefined) {
            return true;
        }

        const members = query.getProperties();
        const select = members.findLast((member) => !Node.isSpreadAssignment(member) && propertyKeyName(member) === "select");

        if (hasExecutableMember(query)) {
            return false;
        }

        if (select === undefined) {
            return !members.some((member) => Node.isSpreadAssignment(member) || staticPropertyName(member.getNameNode()) === undefined);
        }

        if (isOverriddenLater(query, select)) {
            return false;
        }

        const names = unwrapExpression(propertyValueOf(select));

        return (
            Node.isArrayLiteralExpression(names) &&
            names.getElements().some((name) => (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) && name.getLiteralValue() === field)
        );
    });

/** Whether `read`'s row, consumed through `source`, scopes a key whose whole value is `wholeKey`. */
const rowScopesKey = (read: CallExpression, source: TsNode, field: string | undefined, wholeKey: TsNode | undefined): boolean => {
    const callee = read.getExpression();

    const singleRow = Node.isPropertyAccessExpression(callee) && (SINGLE_ROW_READS.has(callee.getName()) || callee.getName().endsWith("OrThrow"));

    if (!isIdentityBoundRead(read) || !singleRow || (field !== undefined && !keepsColumn(read, field))) {
        return false;
    }

    // Used as the entire key, a field of the caller's own row is a stored reference the caller cannot repoint, as long as
    // the row is the caller's on every query path.
    const whole = wholeKey !== undefined && unwrapExpression(source) === unwrapExpression(wholeKey) && isPinnedToCaller(read);

    return whole || isIdentityField(read, field);
};

/**
 * Whether `use` reads a row field with `?.` off a read that can find nothing: then the field is `undefined` for every
 * caller with no row, and they all share one key prefix. A `…OrThrow` read throws instead, so `?.` there is harmless.
 */
const isOptionalReadOfNullableRow = (use: TsNode, read: CallExpression): boolean => {
    const callee = read.getExpression();
    const throwsWhenAbsent = Node.isPropertyAccessExpression(callee) && callee.getName().endsWith("OrThrow");

    return (Node.isPropertyAccessExpression(use) || Node.isElementAccessExpression(use)) && use.hasQuestionDotToken() && !throwsWhenAbsent;
};

/**
 * True when `node` is, or textually contains, a value reference to a key source the
 * caller cannot choose: the caller's identity (a ctx path whose first segment is
 * `auth`, `ctx.auth.userId`), or a value read from the database through a read that
 * is itself bound to that identity (see {@link isIdentityBoundRead}). A row fetched
 * by a caller-supplied id is not such a source, and a field of a caller's row scopes
 * only when it is `wholeKey` or names the caller (see {@link isIdentityField}).
 * Narrower than {@link referencesContext}: `ctx.env.PREFIX` and `ctx.now` are
 * server-trusted but name neither a caller nor a stored record.
 */
const referencesScopedKeySource = (node: TsNode, wholeKey?: TsNode): boolean =>
    valueIdentifiersOf(node).some((identifier) => {
        const outermost = outermostChainOf(identifier);
        const root = contextTrustPathOf(outermost)?.[0];

        // Inside a `ctx.db` call's arguments the identity only scopes the key through that call, judged below. Only
        // calls within the key count: a sink nested in a db write's arguments (`ctx.db.patch(id, { v: await
        // ctx.kv.get(\`${ctx.auth.userId}:…\`) })`) is still scoped by its own identity prefix.
        if (root === "auth") {
            return !isAlternativeOf(identifier, node) && !insideDatabaseCallWithin(identifier, node);
        }

        // A fallback read (`args.key ?? (await ownedRead()).key`) is only taken when the caller sends nothing.
        const call = root === "db" && !isAlternativeOf(identifier, node) ? invokedBy(outermost) : undefined;

        if (call === undefined) {
            return false;
        }

        const { field, read } = rowFieldReadOf(call);

        return !isOptionalReadOfNullableRow(read, call) && rowScopesKey(call, read, field, wholeKey);
    });

/** The `await` operand of `node` (both unwrapped), or `node` itself when it is not awaited. */
const awaitedOperand = (node: TsNode | undefined): TsNode | undefined => {
    const unwrapped = unwrapExpression(node);

    return Node.isAwaitExpression(unwrapped) ? unwrapExpression(unwrapped.getExpression()) : unwrapped;
};

/** The root identifier and the names read off a property/element access chain (`ctx.db.files` → `ctx`, `["db", "files"]`). */
interface AccessPath {
    path: ReadonlyArray<string>;
    root: Identifier;
}

/** `undefined` for any shape that is not a pure access chain on an identifier, so a call or an `await` in the chain fails closed. */
const accessPathOf = (node: TsNode | undefined): AccessPath | undefined => {
    const names: string[] = [];
    let current: TsNode | undefined = unwrapExpression(node);

    while (current !== undefined) {
        if (Node.isPropertyAccessExpression(current)) {
            names.unshift(current.getName());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isElementAccessExpression(current)) {
            const argument = current.getArgumentExpression();

            if (!Node.isStringLiteral(argument)) {
                return undefined;
            }

            names.unshift(argument.getLiteralValue());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isIdentifier(current)) {
            return { path: names, root: current };
        } else {
            return undefined;
        }
    }

    return undefined;
};

/** Whether `identifier` resolves, by symbol, to `declaration`; a spelling match would pass a shadowing binding. */
const bindsTo = (identifier: Identifier, declaration: TsNode): boolean => declarationOf(identifier)?.compilerNode === declaration.compilerNode;

/**
 * The application function a bare-identifier callee names: a function declaration, or a `const`
 * bound to an arrow or function expression, followed through one import alias. Anything declared
 * in a `.d.ts` file or under `node_modules` is not app code and resolves to `undefined`.
 */
const appFunctionOf = (callee: TsNode | undefined): FunctionNode | undefined => {
    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const symbol = referencedSymbolOf(callee);
    const target = symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol;
    const declaration = target?.getValueDeclaration() ?? target?.getDeclarations()[0];

    if (declaration === undefined) {
        return undefined;
    }

    const sourceFile = declaration.getSourceFile();

    if (sourceFile.isDeclarationFile() || sourceFile.isInNodeModules()) {
        return undefined;
    }

    // A reassigned function declaration may not run the body inspected here, and calling a generator
    // runs none of its body: awaiting the generator object it returns checks nothing.
    if (Node.isFunctionDeclaration(declaration)) {
        return declaration.getBody() === undefined || declaration.isGenerator() || isReassignedBinding(declaration) ? undefined : declaration;
    }

    if (!isConstDeclaration(declaration)) {
        return undefined;
    }

    const initializer = unwrapExpression(declaration.getInitializer());

    return Node.isArrowFunction(initializer) || (Node.isFunctionExpression(initializer) && !initializer.isGenerator()) ? initializer : undefined;
};

/**
 * Whether `use` may run before `target` in `enclosing` has completed: it comes earlier in the source, sits in a nested
 * function (which may be called at any time), or shares a loop with `target`, whose next pass runs it first again.
 */
const mayRunBefore = (use: TsNode, target: TsNode, enclosing: FunctionNode): boolean => {
    if (use.getStart() < target.getEnd() || enclosingFunctionOf(use)?.compilerNode !== enclosing.compilerNode) {
        return true;
    }

    return target
        .getAncestors()
        .some((ancestor) => Node.isIterationStatement(ancestor) && ancestor.getStart() <= use.getStart() && use.getEnd() <= ancestor.getEnd());
};

/**
 * Whether `parameter` is assigned in `helper` (`channelId = "general"`, `({ ctx } = other)`), by symbol, where the write
 * may run before `read` completes. A write after the enforcing read cannot change what it checked.
 */
const isReassignedBefore = (parameter: ParameterDeclaration, helper: FunctionNode, read: TsNode): boolean =>
    helper
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some(
            (identifier) =>
                identifier.getText() === parameter.getName() &&
                isWriteTarget(identifier) &&
                declarationOf(identifier)?.compilerNode === parameter.compilerNode &&
                mayRunBefore(identifier, read, helper),
        );

/** A chain of calls and property reads, as a `db` read is written: every call in it, the names read along it, and its root. */
interface DatabaseChain {
    calls: CallExpression[];
    names: ReadonlyArray<string>;
    root: Identifier;
}

/** The chain a read is written as (`ctx.db.query("m").withIndex(…).first()`), or `undefined` for any other shape. */
const databaseChainOf = (node: TsNode | undefined): DatabaseChain | undefined => {
    const calls: CallExpression[] = [];
    const names: string[] = [];
    let current: TsNode | undefined = unwrapExpression(node);

    while (current !== undefined) {
        if (Node.isCallExpression(current)) {
            calls.push(current);
            current = unwrapExpression(current.getExpression());
        } else if (Node.isPropertyAccessExpression(current)) {
            names.unshift(current.getName());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isElementAccessExpression(current)) {
            const argument = current.getArgumentExpression();

            if (!Node.isStringLiteral(argument)) {
                return undefined;
            }

            names.unshift(argument.getLiteralValue());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isIdentifier(current)) {
            return calls.length > 0 && names.length > 0 ? { calls, names, root: current } : undefined;
        } else {
            return undefined;
        }
    }

    return undefined;
};

/**
 * The single-row read a chain ends in. `selfEnforcing` is true for a `…OrThrow` variant, which throws on a
 * miss by itself. `undefined` for any other terminal (`findMany`, `collect`, …).
 */
const singleRowReadOf = (chain: DatabaseChain): { selfEnforcing: boolean } | undefined => {
    const method = chain.names[chain.names.length - 1] ?? "";

    if (SINGLE_ROW_READS.has(method)) {
        return { selfEnforcing: false };
    }

    const base = method.endsWith("OrThrow") ? method.slice(0, -"OrThrow".length) : undefined;

    return base !== undefined && SINGLE_ROW_READS.has(base) ? { selfEnforcing: true } : undefined;
};

/**
 * The row a sink key is read off: `K` (or the initializer of `K` when it is a bare identifier) is an
 * access chain with at least one level, rooted at a single-identifier `const` whose initializer is a
 * `ctx.db` read. `undefined` otherwise, which leaves the sink reported.
 */
const rowDeclarationOf = (key: TsNode): { keyPath: ReadonlyArray<string>; row: VariableDeclaration } | undefined => {
    const unwrapped = unwrapExpression(key);
    const chain = Node.isIdentifier(unwrapped) ? (unwrapExpression(trustedInitializerOf(unwrapped)) ?? unwrapped) : unwrapped;
    const access = accessPathOf(chain);

    if (access === undefined || access.path.length === 0) {
        return undefined;
    }

    const declaration = declarationOf(access.root);

    if (!isConstDeclaration(declaration) || !Node.isIdentifier(declaration.getNameNode())) {
        return undefined;
    }

    // Only a single-row read: an insert or update returns the row as the caller wrote it.
    const read = awaitedOperand(declaration.getInitializer());
    const readChain = Node.isCallExpression(read) && contextTrustPathOf(read.getExpression())?.[0] === "db" ? databaseChainOf(read) : undefined;

    return readChain !== undefined && singleRowReadOf(readChain) !== undefined ? { keyPath: access.path, row: declaration } : undefined;
};

/** A use of a helper parameter that received the row's value at `prefix` (`[]` for the whole row). */
interface HelperRowUse {
    prefix: RowPath;
    use: Identifier;
}

/**
 * The uses of the helper parameter `tied`, which received the row's value at `argumentPath`, and the row paths they
 * read. Each use is judged later against every guarded path, the key's included, which the helper cannot see: a
 * helper running `Object.assign(row.meta, …)` replaces a key at `row.meta.key` however it checks `row.channelId`.
 */
const helperRowUsesOf = (helper: FunctionNode, tied: ParameterDeclaration, argumentPath: RowPath): { reads: RowPath[]; uses: HelperRowUse[] } => {
    const uses = helper
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((identifier) => identifier !== tied.getNameNode() && declarationOf(identifier)?.compilerNode === tied.compilerNode);
    // A write (`message.views += 1`) reads nothing the check depends on; it is judged as a use against what the check
    // reads and the key.
    const reads = uses.flatMap((use) => {
        const { node, path } = accessChainFrom(use);
        const read = [...argumentPath, ...(isInvoked(node) ? path.slice(0, -1) : path)];

        return isBareRowTest(node, read) || isWriteTarget(node) ? [] : [read];
    });

    return {
        reads,
        uses: uses.map((use) => {
            return { prefix: argumentPath, use };
        }),
    };
};

/** Every argument of the chain, and every node inside each argument (a callback's body included). */
const chainArgumentNodes = (chain: DatabaseChain): TsNode[] =>
    chain.calls.flatMap((call) => call.getArguments().flatMap((argument) => [argument, ...argument.getDescendants()]));

/**
 * Whether `node` names a binding made by a direct element of `const { … } = P.auth…`: no nesting, rest or
 * default, so `{ userId }` and `{ userId: uid }` count while `{ auth: { userId } } = ctx` does not.
 */
const isDirectDestructuredIdentityOf = (node: TsNode, parameter: ParameterDeclaration): boolean => {
    const element = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    if (!Node.isBindingElement(element) || element.getDotDotDotToken() !== undefined || element.getInitializer() !== undefined) {
        return false;
    }

    const pattern = element.getParent();
    const declaration = Node.isObjectBindingPattern(pattern) ? pattern.getParent() : undefined;

    if (!isConstDeclaration(declaration)) {
        return false;
    }

    const source = accessPathOf(declaration.getInitializer());

    return source !== undefined && isCallerIdPath([...source.path, bindingKeyName(element)]) && bindsTo(source.root, parameter);
};

/**
 * Whether `node` reads the caller's identity through the ctx parameter `parameter`: a `P.auth…` chain, an
 * identifier whose one-hop `const` initializer is one (`const userId = ctx.auth.userId`), or a name a
 * direct `const { userId } = ctx.auth` destructuring binds (the form `prefer-destructuring` enforces).
 */
const isIdentityReadOf = (node: TsNode, parameter: ParameterDeclaration): boolean => {
    const access = accessPathOf(node);

    if (access !== undefined && access.path.length > 0) {
        return isCallerIdPath(access.path) && bindsTo(access.root, parameter);
    }

    const initializerAccess = accessPathOf(trustedInitializerOf(node));

    if (initializerAccess !== undefined && isCallerIdPath(initializerAccess.path) && bindsTo(initializerAccess.root, parameter)) {
        return true;
    }

    return isDirectDestructuredIdentityOf(node, parameter);
};

/**
 * Whether `call` is a row read rooted at the helper's ctx parameter (`context.db.members.findFirst(…)`), whatever the
 * parameter is named. A read rooted anywhere else is not the helper's query.
 */
const isParameterDatabaseRead = (call: CallExpression, parameter: ParameterDeclaration): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !DB_READ_METHODS.has(callee.getName())) {
        return false;
    }

    let surface: TsNode = callee;

    while ((Node.isPropertyAccessExpression(surface) || Node.isElementAccessExpression(surface)) && !Node.isIdentifier(surface.getExpression())) {
        surface = surface.getExpression();
    }

    const root = Node.isPropertyAccessExpression(surface) ? surface.getExpression() : undefined;

    return (
        Node.isPropertyAccessExpression(surface) &&
        surface.getName() === "db" &&
        Node.isIdentifier(root) &&
        declarationOf(root)?.compilerNode === parameter.compilerNode
    );
};

/**
 * Whether the read argument `argument` reads the caller's identity through `parameter` with no alternative beside it.
 * `victim ?? ctx.auth.userId` reads the identity only when nothing else is supplied, and `ctx.auth.userId ?? victim`
 * reads the victim for an anonymous caller, whose `userId` is null.
 */
const argumentReadsIdentityOf = (argument: TsNode, parameter: ParameterDeclaration): boolean =>
    [argument, ...argument.getDescendants()].some(
        (node) =>
            isIdentityReadOf(node, parameter) &&
            !hasAlternativeWithin(node, argument) &&
            constrainsMatch(node, (call) => isParameterDatabaseRead(call, parameter)),
    );

/** The declaration a variable statement makes, when it is a single `const` binding one identifier. */
const constDeclarationOf = (statement: TsNode): VariableDeclaration | undefined => {
    if (!Node.isVariableStatement(statement)) {
        return undefined;
    }

    const declarations = statement.getDeclarations();
    const declaration = declarations.length === 1 ? declarations[0] : undefined;

    return declaration !== undefined && isConstDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) ? declaration : undefined;
};

/**
 * Whether `condition` is `!g`, `g === null`, `g == null` or `g == undefined`, in either operand order, for the binding
 * `g`. A single-row read answers `null` on a miss, so `g === undefined` never fires and is not a check.
 */
const isMissingCheck = (condition: TsNode | undefined, declaration: VariableDeclaration): boolean => {
    const expression = unwrapExpression(condition);
    const isBinding = (node: TsNode | undefined): boolean => Node.isIdentifier(node) && bindsTo(node, declaration);

    if (Node.isPrefixUnaryExpression(expression)) {
        return expression.getOperatorToken() === SyntaxKind.ExclamationToken && isBinding(unwrapExpression(expression.getOperand()));
    }

    if (!Node.isBinaryExpression(expression)) {
        return false;
    }

    const operator = expression.getOperatorToken().getKind();
    const isMissing = (node: TsNode | undefined): boolean =>
        operator === SyntaxKind.EqualsEqualsEqualsToken
            ? Node.isNullLiteral(node)
            : operator === SyntaxKind.EqualsEqualsToken && (Node.isNullLiteral(node) || isUndefinedGlobal(node));
    const left = unwrapExpression(expression.getLeft());
    const right = unwrapExpression(expression.getRight());

    return (isBinding(left) && isMissing(right)) || (isBinding(right) && isMissing(left));
};

/** Whether a branch's last statement (the branch itself, or its block's last statement) leaves the handler: a `throw`, or a `return` unless `throwOnly`. */
const exitsBranch = (branch: TsNode | undefined, throwOnly: boolean): boolean => {
    const statements = Node.isBlock(branch) ? branch.getStatements() : undefined;
    const last = statements === undefined ? branch : statements[statements.length - 1];

    return Node.isThrowStatement(last) || (!throwOnly && Node.isReturnStatement(last));
};

/** Whether `statement` is an `if` with no `else` that exits when the binding `g` is missing. */
const isNullCheckExit = (statement: TsNode | undefined, declaration: VariableDeclaration, throwOnly: boolean): boolean =>
    Node.isIfStatement(statement) &&
    statement.getElseStatement() === undefined &&
    isMissingCheck(statement.getExpression(), declaration) &&
    exitsBranch(statement.getThenStatement(), throwOnly);

/**
 * The statement of `helper`'s own body that enforces the identity check of {@link helperGuardOf}: a top-level
 * `const r = await P.db…` single-row read whose chain reads the caller's identity through `parameter` and
 * references a parameter that received the row. It is enforced by a later `if (!r)` / `if (r == null)` in
 * the same block whose branch throws, or by the read itself when it is a `…OrThrow` variant.
 */
const enforcedReadOf = (helper: FunctionNode, parameter: ParameterDeclaration, tiedParameters: ReadonlyArray<ParameterDeclaration>): TsNode | undefined => {
    const body = helper.getBody();

    if (!Node.isBlock(body)) {
        return undefined;
    }

    const statements = body.getStatements();

    return statements.find((statement, index) => {
        const declaration = constDeclarationOf(statement);
        const initializer = unwrapExpression(declaration?.getInitializer());
        const chain = Node.isAwaitExpression(initializer) ? databaseChainOf(initializer.getExpression()) : undefined;
        const single = chain === undefined ? undefined : singleRowReadOf(chain);

        if (declaration === undefined || chain === undefined || single === undefined || chain.names[0] !== "db" || !bindsTo(chain.root, parameter)) {
            return false;
        }

        const nodes = chainArgumentNodes(chain);
        const readsIdentity = chain.calls.some((call) => call.getArguments().some((argument) => argumentReadsIdentityOf(argument, parameter)));
        const readsRow = tiedParameters.some((tied) => nodes.some((node) => Node.isIdentifier(node) && bindsTo(node, tied)));

        if (!readsIdentity || !readsRow) {
            return false;
        }

        const enforcing = single.selfEnforcing ? statement : statements.slice(index + 1).find((later) => isNullCheckExit(later, declaration, true));

        // A `return` before the check is enforced lets a call complete without it.
        return (
            enforcing !== undefined &&
            !helper
                .getDescendantsOfKind(SyntaxKind.ReturnStatement)
                .some((exit) => enclosingFunctionOf(exit)?.compilerNode === helper.compilerNode && exit.getStart() < enforcing.getEnd())
        );
    });
};

/**
 * The helper parameters that receive the row or a field read off it, with the row paths the helper reads through
 * each and every use of each (see {@link helperRowUsesOf}).
 */
const tiedArgumentsOf = (
    helper: FunctionNode,
    args: ReadonlyArray<TsNode>,
    contextIndex: number,
    row: VariableDeclaration,
): { argument: TsNode; reads: RowPath[]; tied: ParameterDeclaration; uses: HelperRowUse[] }[] | undefined => {
    const tiedArguments: { argument: TsNode; reads: RowPath[]; tied: ParameterDeclaration; uses: HelperRowUse[] }[] = [];

    for (const [index, argument] of args.entries()) {
        // The argument must be the row or a field read off it; `args.id || row.id` may pass the caller's value.
        const access = accessPathOf(unwrapExpression(argument));

        if (index !== contextIndex && access !== undefined && bindsTo(access.root, row)) {
            const tied = helper.getParameters()[index];

            // A destructured or rest parameter, or none at all, holds the row where its uses cannot be followed.
            if (tied === undefined || tied.isRestParameter() || !Node.isIdentifier(tied.getNameNode())) {
                return undefined;
            }

            tiedArguments.push({ argument, tied, ...helperRowUsesOf(helper, tied, access.path) });
        }
    }

    return tiedArguments;
};

/**
 * Whether a non-arrow `helper` reads its own `arguments` object, which aliases every parameter: `arguments[1].key = …`
 * writes the row without naming the parameter its uses are followed through. An arrow function has no `arguments`
 * of its own, and a nested non-arrow function reads its own.
 */
const readsOwnArguments = (helper: FunctionNode): boolean =>
    !Node.isArrowFunction(helper) &&
    valueIdentifiersIn(helper).some(
        (identifier) =>
            identifier.getText() === "arguments" &&
            identifier.getFirstAncestor((ancestor) => isFunctionNode(ancestor) && !Node.isArrowFunction(ancestor))?.compilerNode === helper.compilerNode,
    );

/**
 * The row paths a helper call guards, and its uses of the row, when it is an identity guard for the row;
 * `undefined` otherwise. It is one when the handler's ctx is its only ctx-valued argument, another argument
 * references the row, and the helper's body enforces the identity read of {@link enforcedReadOf}. A helper that
 * may return a Promise must be awaited. Whether the helper leaves the guarded values alone is judged by the caller,
 * which knows the key's path.
 */
const helperGuardOf = (call: CallExpression, row: VariableDeclaration, awaited: boolean): Required<RowGuard> | undefined => {
    const helper = appFunctionOf(call.getExpression());
    const args = call.getArguments();

    if (helper === undefined || args.some((argument) => Node.isSpreadElement(argument))) {
        return undefined;
    }

    const contextIndexes = args.flatMap((argument, index) => (contextTrustPathOf(argument)?.length === 0 ? [index] : []));
    const contextIndex = contextIndexes.length === 1 ? contextIndexes[0] : undefined;
    const parameter = contextIndex === undefined ? undefined : helper.getParameters()[contextIndex];

    if (contextIndex === undefined || parameter === undefined || parameter.isRestParameter() || !Node.isIdentifier(parameter.getNameNode())) {
        return undefined;
    }

    const tiedArguments = tiedArgumentsOf(helper, args, contextIndex, row);

    if (tiedArguments === undefined) {
        return undefined;
    }

    const tiedParameters = tiedArguments.map(({ tied }) => tied);
    const guardedPaths = tiedArguments.flatMap(({ reads }) => reads);

    const returnType = helper.getReturnType();
    const mayBePromise = helper.isAsync() || returnType.isAny() || returnType.isUnknown() || returnType.getText().includes("Promise");

    if (tiedParameters.length === 0 || (!awaited && mayBePromise) || readsOwnArguments(helper)) {
        return undefined;
    }

    const read = enforcedReadOf(helper, parameter, tiedParameters);

    if (read === undefined) {
        return undefined;
    }

    // A default or a reassignment that runs before the enforcing read replaces what the call passed: a row field that
    // is `undefined` takes `channelId = "general"`, and `ctx = other` checks someone else's identity.
    return [parameter, ...tiedParameters].some((candidate) => candidate.hasInitializer() || isReassignedBefore(candidate, helper, read))
        ? undefined
        : { guardedPaths, helperArguments: tiedArguments.map(({ argument }) => argument), helperUses: tiedArguments.flatMap(({ uses }) => uses) };
};

/**
 * The `const g = await ctx.db…(…)` an inline guard reads: a single-row read rooted at the handler's ctx,
 * identity-bound in one of its calls (see {@link isIdentityBoundRead}), with an argument referencing the row.
 * `selfEnforcing` is true for a `…OrThrow` read, which needs no following `if`.
 */
const inlineGuardOf = (statement: TsNode, row: VariableDeclaration): { declaration: VariableDeclaration; selfEnforcing: boolean } | undefined => {
    const declaration = constDeclarationOf(statement);
    const initializer = unwrapExpression(declaration?.getInitializer());
    const chain = Node.isAwaitExpression(initializer) ? databaseChainOf(initializer.getExpression()) : undefined;
    const single = chain === undefined ? undefined : singleRowReadOf(chain);

    if (declaration === undefined || chain === undefined || single === undefined || chain.names[0] !== "db" || contextTrustPathOf(chain.root)?.length !== 0) {
        return undefined;
    }

    // The chain is already a `ctx.db` single-row read, so any of its calls may carry the identity: a fluent
    // `query(…).withIndex(…).first()` names it in `withIndex`, which `isIdentityBoundRead` cannot trace to `ctx.db`.
    const identityBound = chain.calls.some((call) => call.getArguments().some((argument) => readsCallerIdentity(argument)));
    const tied = chainArgumentNodes(chain).some((node) => Node.isIdentifier(node) && bindsTo(node, row));

    return identityBound && tied ? { declaration, selfEnforcing: single.selfEnforcing } : undefined;
};

/**
 * Whether `statement` runs before the sink on every path through the handler: no function, `if`,
 * loop, `switch` case or `catch` between it and `enclosing`. A `try` with a `catch` is allowed only when
 * both the statement and the sink lie in its `try` block.
 */
const runsBeforeSinkUnconditionally = (statement: TsNode, enclosing: FunctionNode, sinkCall: TsNode): boolean => {
    const within = (node: TsNode, container: TsNode): boolean => container.getStart() <= node.getStart() && node.getEnd() <= container.getEnd();

    for (let ancestor = statement.getParent(); ancestor !== undefined && ancestor.compilerNode !== enclosing.compilerNode; ancestor = ancestor.getParent()) {
        if (
            isFunctionNode(ancestor) ||
            Node.isIfStatement(ancestor) ||
            Node.isIterationStatement(ancestor) ||
            Node.isCaseClause(ancestor) ||
            Node.isDefaultClause(ancestor) ||
            Node.isCatchClause(ancestor)
        ) {
            return false;
        }

        if (Node.isTryStatement(ancestor) && ancestor.getCatchClause() !== undefined) {
            const tryBlock = ancestor.getTryBlock();

            if (!within(statement, tryBlock) || !within(sinkCall, tryBlock)) {
                return false;
            }
        }
    }

    return true;
};

/**
 * The key path and the guard's `reads`, without a read below the key: a guard reading `row.meta.key.length` adds
 * nothing to a key at `row.meta.key`, and kept, it would make the key a holder whose hand-off to the sink counts as an
 * escape. A read below another read stays, so a holder the guard both reads through and hands on is still one.
 */
const guardedPathsOf = (keyPath: RowPath, reads: ReadonlyArray<RowPath>): RowPath[] => [keyPath, ...reads.filter((read) => !holds(keyPath, read))];

/** An identity guard found for the row: the row paths it read and, for a helper, the arguments that hand it the row and the helper's uses of them. */
interface RowGuard {
    guardedPaths: RowPath[];
    helperArguments?: TsNode[];
    helperUses?: HelperRowUse[];
}

/** The row paths an inline guard's read takes off `row`: `message.channelId` in its `where` reads `["channelId"]`. */
const inlineGuardPathsOf = (declaration: VariableDeclaration, row: VariableDeclaration): RowPath[] =>
    declaration.getDescendantsOfKind(SyntaxKind.Identifier).flatMap((identifier) => {
        if (!bindsTo(identifier, row)) {
            return [];
        }

        const { node, path } = accessChainFrom(identifier);
        const read = isInvoked(node) ? path.slice(0, -1) : path;

        return isBareRowTest(node, read) ? [] : [read];
    });

/** The helper guard `statement` is, an expression statement `await h(…)` or `h(…)`, or `undefined`. */
const helperGuardStatementOf = (statement: TsNode, row: VariableDeclaration): RowGuard | undefined => {
    if (!Node.isExpressionStatement(statement)) {
        return undefined;
    }

    const expression = unwrapExpression(statement.getExpression());
    const isAwaited = Node.isAwaitExpression(expression);
    const call = isAwaited ? unwrapExpression(expression.getExpression()) : expression;
    return Node.isCallExpression(call) ? helperGuardOf(call, row, isAwaited) : undefined;
};

/**
 * Every identity guard for `row` among the statements before the sink's own statement (`statements[index]`): a
 * helper-guard call, or an inline single-row read followed directly by its enforcing `if` (or a `…OrThrow` read,
 * which enforces on its own).
 */
const precedingGuardsOf = (statements: ReadonlyArray<TsNode>, index: number, row: VariableDeclaration, enclosing: FunctionNode, sinkCall: TsNode): RowGuard[] =>
    statements.slice(0, index).flatMap((statement, position) => {
        if (!runsBeforeSinkUnconditionally(statement, enclosing, sinkCall)) {
            return [];
        }

        const helperGuard = helperGuardStatementOf(statement, row);

        if (helperGuard !== undefined) {
            return [helperGuard];
        }

        const inline = inlineGuardOf(statement, row);

        return inline !== undefined && (inline.selfEnforcing || (position + 1 < index && isNullCheckExit(statements[position + 1], inline.declaration, false)))
            ? [{ guardedPaths: inlineGuardPathsOf(inline.declaration, row) }]
            : [];
    });

/** `node` with any `await`, parentheses and type assertions removed. */
const unawaited = (node: TsNode): TsNode => {
    let current = unwrapExpression(node) ?? node;

    while (Node.isAwaitExpression(current)) {
        current = unwrapExpression(current.getExpression()) ?? current.getExpression();
    }

    return current;
};

/** A call or `new` under any `await`, parentheses or type assertion: `await sha256Hex(args.bytes)` recomputes its input. */
const isRecomputed = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) || Node.isNewExpression(current);
};

/** Whether `node` is any `ctx.db` call under any `await`. */
const isDatabaseCallSource = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && contextTrustPathOf(current.getExpression())?.[0] === "db";
};

/** Whether `node` is a `ctx.db` row read under any `await`. */
const isDatabaseReadSource = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && isDatabaseReadCall(current);
};

/** Whether `node` reads `args` itself or through one local (`const requestedKey = args.key`). */
const reachesArgsWithinOneHop = (node: TsNode): boolean =>
    referencesBinding(node, "args") ||
    valueIdentifiersOf(node).some((identifier) => {
        const initializer = trustedInitializerOf(identifier);

        return initializer !== undefined && referencesBinding(initializer, "args");
    });

/**
 * The defaults on the path to the destructured element of `variable` that binds `name`: its own
 * (`const { url = args.url } = config`) and every enclosing element's
 * (`const { network: { url } = args.network } = config`), each of which can supply the value.
 */
const bindingDefaultsOf = (variable: VariableDeclaration | undefined, name: string): TsNode[] => {
    const element = variable
        ?.getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .find((candidate) => Node.isIdentifier(candidate.getNameNode()) && candidate.getNameNode().getText() === name);

    if (element === undefined) {
        return [];
    }

    return [element, ...element.getAncestors().filter((ancestor) => Node.isBindingElement(ancestor))]
        .map((node) => (Node.isBindingElement(node) ? node.getInitializer() : undefined))
        .filter((initializer) => initializer !== undefined);
};

/**
 * For a name destructured from a `ctx.db` read (`const { key } = await ctx.db.files.findFirst(…)`),
 * that read; `undefined` for any other binding. Only a read qualifies: every field of a row the read
 * bound to the caller is the caller's own, while a literal's sibling `ctx.auth` field says nothing
 * about the field taken from it.
 */
const ownedRowInitializerOf = (node: TsNode): TsNode | undefined => {
    const element = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    if (!Node.isBindingElement(element) || isReassignedBinding(element)) {
        return undefined;
    }

    const variable = element.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const initializer = variable?.getInitializer();

    // `const { storageKey = args.key } = await ownedRead()` takes the caller's key whenever the row lacks the field.
    if (bindingDefaultsOf(variable, node.getText()).some((fallback) => reachesArgsWithinOneHop(fallback))) {
        return undefined;
    }

    return initializer !== undefined && isDatabaseReadSource(initializer) ? initializer : undefined;
};

/** The `ctx.db` row read under any `await` in `node`, or `undefined`. */
const databaseReadOf = (node: TsNode): CallExpression | undefined => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && isDatabaseReadCall(current) ? current : undefined;
};

/** The column a destructured `element` takes from the row; `undefined` below the top level of the pattern. */
const destructuredFieldOf = (element: TsNode | undefined): string | undefined => {
    // Only a top-level `{ column }` binds a column: `const { ...rest } = row` binds an object of the remaining
    // columns, and `const [row] = await findMany(…)` a whole row.
    if (
        !Node.isBindingElement(element) ||
        !Node.isObjectBindingPattern(element.getParent()) ||
        element.getDotDotDotToken() !== undefined ||
        Node.isBindingElement(element.getParent().getParent())
    ) {
        return undefined;
    }

    return bindingKeyName(element);
};

/**
 * Whether every use of the local `identifier` leaves its fields as read: reads (`row.ownerId`, `const { _id } = row`),
 * a spread copy (`{ ...row }`) or a `return`. A write anywhere in a chain on it, an alias, or passing it to a call can
 * change the field the key emits, since the callee may write into it.
 */
const isReadOnlyLocal = (identifier: Identifier): boolean =>
    usesOfLocal(identifier).every((use) => {
        const wrapped = valueWrapperOf(use);
        const parent = wrapped.getParent();

        // Destructuring and a spread copy the row's fields without writing into it. A `return` hands out the row itself,
        // and a write through the returned alias would go unseen here, so it does not count.
        if ((Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode())) || Node.isSpreadAssignment(parent)) {
            return true;
        }

        return (
            (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
            parent.getExpression() === wrapped &&
            !isWriteTarget(valueWrapperOf(outermostChainOf(parent)))
        );
    });

/**
 * Whether the local `identifier` names a key source the caller cannot choose, one hop back. A
 * local holding a whole row (`const row = await ctx.db.files.findFirst(…)`) is judged by the
 * field read off it here; a destructured one (`const { key } = await …`) by the field it took.
 */
const bindingScopesKey = (identifier: TsNode, wholeKey: TsNode | undefined): boolean => {
    const isWhole = wholeKey !== undefined && unwrapExpression(identifier) === unwrapExpression(wholeKey);
    const trusted = trustedInitializerOf(identifier);

    if (trusted !== undefined) {
        const read = databaseReadOf(trusted);

        if (read === undefined) {
            return referencesScopedKeySource(trusted, isWhole ? trusted : undefined);
        }

        // `const row` still allows `row.ownerId = args.ownerId`, so a row local counts only while nothing writes into it.
        if (Node.isIdentifier(identifier) && !isReadOnlyLocal(identifier)) {
            return false;
        }

        const { field, read: use } = rowFieldReadOf(identifier);

        if (isOptionalReadOfNullableRow(use, read)) {
            return false;
        }

        return rowScopesKey(read, use, field, wholeKey);
    }

    const owned = ownedRowInitializerOf(identifier);
    const read = owned === undefined ? undefined : databaseReadOf(owned);

    return read !== undefined && Node.isIdentifier(identifier) && rowScopesKey(read, identifier, destructuredFieldOf(declarationOf(identifier)), wholeKey);
};

/**
 * The parts of a key built by concatenation, in order: template spans and `+` operands, with
 * nested templates and `+` chains flattened into them. A single part for anything else.
 */
/** One part of a concatenated key, and the node in the key it lands at: a local's reference for a part of its initializer. */
interface KeyPart {
    anchor: TsNode;
    part: TsNode;
}

const keyPartsOf = (node: TsNode, followLocal = true): KeyPart[] => {
    const value = strippedValue(node);

    if (Node.isTemplateExpression(value)) {
        return value.getTemplateSpans().flatMap((span) => keyPartsOf(span.getExpression(), followLocal));
    }

    if (Node.isBinaryExpression(value) && value.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
        return [...keyPartsOf(value.getLeft(), followLocal), ...keyPartsOf(value.getRight(), followLocal)];
    }

    // A prefix factored into a local (`const prefix = \`${uid}/${args.tenant}\``) is judged by its parts, one hop deep.
    const initializer = followLocal && Node.isIdentifier(value) ? trustedInitializerOf(value) : undefined;
    const composed = initializer === undefined ? undefined : strippedValue(initializer);

    if (
        composed !== undefined &&
        (Node.isTemplateExpression(composed) || (Node.isBinaryExpression(composed) && composed.getOperatorToken().getKind() === SyntaxKind.PlusToken))
    ) {
        // The local's parts sit in its initializer; the reference is where they land in the key.
        return keyPartsOf(composed, false).map(({ part }) => {
            return { anchor: value, part };
        });
    }

    return [{ anchor: value, part: value }];
};

const isFixedTextPart = (part: TsNode): boolean => Node.isStringLiteral(part) || Node.isNoSubstitutionTemplateLiteral(part) || Node.isNumericLiteral(part);

/** Whether `access` reads an identity column straight off an owned row: `row._id`, `(await ownedRead()).ownerId`. */
const isOwnedIdentityColumn = (access: ElementAccessExpression | PropertyAccessExpression): boolean => {
    const base = strippedValue(access.getExpression());
    const baseInitializer = Node.isIdentifier(base) ? trustedInitializerOf(base) : undefined;

    // `const row` still allows `row.ownerId = args.ownerId`, so a row local counts only while nothing writes into it.
    if (Node.isIdentifier(base) && baseInitializer !== undefined && !isReadOnlyLocal(base)) {
        return false;
    }

    const read = databaseReadOf(base) ?? (baseInitializer === undefined ? undefined : databaseReadOf(baseInitializer));

    return (
        read !== undefined && !isOptionalReadOfNullableRow(access, read) && rowScopesKey(read, access, rowFieldReadOf(access.getExpression()).field, undefined)
    );
};

/** Whether `identifier` is destructured as a whole field from the caller's identity (`const { userId } = ctx.auth`) or an owned row's identity column. */
const isDestructuredIdentity = (identifier: Identifier): boolean => {
    const declaration = declarationOf(identifier);
    const field = destructuredFieldOf(declaration);
    const source = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer() : undefined;
    const sourcePath = source === undefined ? undefined : contextTrustPathOf(strippedValue(source));

    if (sourcePath !== undefined) {
        return sourcePath.length === 1 && sourcePath[0] === "auth" && field === CALLER_ID_MEMBER;
    }

    const owned = ownedRowInitializerOf(identifier);
    const read = owned === undefined ? undefined : databaseReadOf(owned);

    return read !== undefined && rowScopesKey(read, identifier, field, undefined);
};

/**
 * Whether `part` is the caller's identity itself, unaltered: `ctx.auth.userId`, an identity column read
 * straight off an owned row (`row._id`, `(await ownedRead())._id`), or a local bound to one of those.
 * Anything computed from the identity (`.length`, `[0]`, `.slice(0, 0)`, `uid && "x"`) can yield the same
 * text for every caller, so it is not.
 */
const isIntactIdentityPart = (part: TsNode, followLocal = true): boolean => {
    const value = strippedValue(part);
    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    // `contextTrustPathOf` follows a local to what it was declared from; a `let` assigned again may hold anything.
    if ((Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration)) && isReassignedBinding(declaration)) {
        return false;
    }

    const path = contextTrustPathOf(value);

    if (path !== undefined) {
        return path.length === 2 && path[0] === "auth" && path[1] === CALLER_ID_MEMBER;
    }

    if (Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value)) {
        return isOwnedIdentityColumn(value);
    }

    if (!Node.isIdentifier(value)) {
        return false;
    }

    const trusted = trustedInitializerOf(value);

    return trusted === undefined ? isDestructuredIdentity(value) : followLocal && isIntactIdentityPart(trusted, false);
};

/**
 * Whether `identifier`, a caller value in a fallback position, lands after the caller's identity in
 * `within`: `within` is built by concatenation, its first part that is not fixed text is the intact
 * identity, and `identifier` sits in a later part. Whichever alternative is then taken, it is appended
 * under the caller's own prefix. The structure is checked as written, so a caller part ahead of the
 * identity (`${args.tenant}/${uid}/${args.a ?? args.b}`), an identity after the fallback, or an identity
 * altered on the way (`${uid.slice(0, 0)}/…`) all leave the fallback refused.
 */
const followsIdentityPrefix = (identifier: TsNode, within: TsNode, reference: TsNode = identifier): boolean => {
    const parts = keyPartsOf(within);
    const contains = (node: TsNode, inner: TsNode): boolean => node.getPos() <= inner.getPos() && inner.getEnd() <= node.getEnd();
    const leading = parts.findIndex(({ part }) => !isFixedTextPart(part));
    // A local's expanded parts keep their order at the local's place in the key, so a fallback inside one is placed by
    // its own part (`${uid}/${args.a ?? args.b}` puts it after the identity), and one in a local that was not expanded
    // by that local's reference.
    const inPart = parts.findIndex(({ part }) => contains(part, identifier));
    const holder = inPart === -1 ? parts.findIndex(({ anchor, part }) => contains(part, reference) || contains(anchor, reference)) : inPart;
    const first = parts[leading];

    return first !== undefined && leading < holder && isIntactIdentityPart(first.part);
};

/** True when `node` is, or textually contains, a value reference to the `args` binding. */
export const referencesArgs = (node: TsNode): boolean => referencesBinding(node, "args");

/**
 * When `node` is a bare identifier bound by a `const key = args.key` (or by a
 * destructure such as `const { key } = args`) in the enclosing handler, return that
 * declaration so a *single* extra hop of taint can be checked (`const key = args.key;
 * … key`); otherwise `undefined`. Only same-function declarations are followed — the
 * taint stays deliberately single-hop.
 */
export const singleHopDeclaration = (node: TsNode): VariableDeclaration | undefined => {
    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const name = node.getText();
    const enclosingFunction = node.getFirstAncestor(
        (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
    );

    if (enclosingFunction === undefined) {
        return undefined;
    }

    // The nearest same-named `const` declared *before* this use. A declaration that
    // follows the use — or a shadowing one in a sibling branch — can't be its source,
    // so preferring the closest preceding binding avoids resolving through a shadow.
    // Kept spelling-based on purpose: over-resolving here only makes the taint
    // predicate report MORE, which fails open. The project does carry a type
    // checker, and a predicate that SILENCES on a match must use it instead, as
    // the owner-field feeder does for mutator impls (`implTaintOf`).
    // A declaration inside a nested function is out of scope at this use, so it cannot be its source.
    const usePosition = node.getStart();
    let nearest: VariableDeclaration | undefined;
    let nearestPosition = -1;

    for (const variable of descendantsOfKind(enclosingFunction, SyntaxKind.VariableDeclaration)) {
        if (!declaresName(variable, name)) {
            continue;
        }

        // A binding in a block that does not contain the use is a different variable,
        // and taking its initializer would replace the real source.
        const scope = bindingScope(variable, enclosingFunction);

        if (scope === undefined || usePosition < scope.getStart() || usePosition >= scope.getEnd()) {
            continue;
        }

        const initializer = variable.getInitializer();
        const declarationPosition = variable.getStart();

        if (initializer !== undefined && declarationPosition < usePosition && declarationPosition > nearestPosition) {
            nearest = variable;
            nearestPosition = declarationPosition;
        }
    }

    return nearest;
};

/** The initializer of {@link singleHopDeclaration}: for a destructured binding, the whole object it was taken from. */
export const singleHopInitializer = (node: TsNode): TsNode | undefined => singleHopDeclaration(node)?.getInitializer();

/**
 * True when `expression` is derived from the handler's `args` — directly (`args.x`,
 * a template / `new URL(...)` / helper call embedding `args.*`), through one local
 * hop on the expression itself (`const key = args.key; … key`), or through one hop
 * on each value identifier composed into a larger expression (`const host =
 * args.host; fetch(\`https://${host}/x\`)`). Each identifier is followed one hop
 * only; an initializer is never followed again. This is the shared taint predicate
 * every Wave 3 sink feeder (SSRF fetch, owner-field write, storage/kv IDOR) reads.
 */
export const isArgumentDerived = (expression: TsNode): boolean => {
    if (referencesArgs(expression)) {
        return true;
    }

    // A destructured binding's default (`const { url = args.url } = config`) supplies the value
    // whenever the object lacks the field, so it is a source alongside the initializer.
    const reachesArgs = (node: TsNode): boolean => {
        const variable = singleHopDeclaration(node);
        const initializer = variable?.getInitializer();
        return (
            (initializer !== undefined && referencesArgs(initializer)) ||
            bindingDefaultsOf(variable, node.getText()).some((fallback) => referencesArgs(fallback))
        );
    };

    return reachesArgs(expression) || valueIdentifiersIn(expression).some((identifier) => reachesArgs(identifier));
};

/**
 * True when `expression` — or its single-hop initializer — is NOT itself a call
 * (a `CallExpression` or `new` expression) that could transform the value before
 * it reaches the sink. `isArgumentDerived` deliberately also matches "a helper
 * call embedding `args.*`" (e.g. `hash(args.key)`, `deriveKey(args)`) so taint
 * detection stays fail-open; that is right for most sinks, but wrong for a rule
 * whose entire premise is that the caller controls the exact bytes reaching the
 * sink. A content-addressed key — the return of a server-side `storeFile(...)`
 * helper, itself the SHA-256 of the uploaded bytes — textually references
 * `args` (it IS the arg) yet is not attacker-chosen, because the call in
 * between recomputed it from data the server already trusts.
 *
 * Only a direct member/element-access chain, a template literal, or a binary
 * concatenation reaches here as "unmodified" — a wrapping call anywhere between
 * the sink argument and its (at most single-hop) `args`/`ctx` root means the
 * value was derived, not merely forwarded, so the rule should not treat it as
 * caller-controlled input reaching the sink verbatim.
 */
export const isUnmodifiedArgumentPassthrough = (node: TsNode): boolean => {
    if (isRecomputed(node)) {
        return false;
    }

    // A default that forwards args reaches the sink whenever the object lacks the field.
    if (bindingDefaultsOf(singleHopDeclaration(node), node.getText()).some((fallback) => referencesArgs(fallback) && !isRecomputed(fallback))) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    // A row fetched by a caller-supplied id is a lookup, not a recomputation, as below for composed keys.
    if (initializer !== undefined && isRecomputed(initializer) && !(isDatabaseReadSource(initializer) && referencesArgs(initializer))) {
        return false;
    }

    const composed = initializer ?? node;

    if (referencesArgs(composed)) {
        return true;
    }

    // `isArgumentDerived` also follows each composed identifier one hop, so a key built only from
    // call results (`blobs/${digest}` with `digest = sha256Hex(args.bytes)`) is tainted but was
    // recomputed; it is a passthrough only when some composed binding forwards args unchanged.
    // An identifier read inside a call in the key (`blobs/${sha256Hex(name)}`) is recomputed there.
    return valueIdentifiersIn(composed).some((identifier) => {
        const nearest = identifier.getFirstAncestor((ancestor) => ancestor === composed || Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor));

        if (nearest !== composed) {
            return false;
        }

        const declaration = singleHopDeclaration(identifier);
        // A `ctx.db` call is a lookup or a write, not a recomputation: a key read off the row it returns is the one the
        // caller pointed at, or the one the caller wrote.
        const forwards = (source: TsNode | undefined): boolean =>
            source !== undefined && referencesArgs(source) && (!isRecomputed(source) || isDatabaseCallSource(source));

        return forwards(declaration?.getInitializer()) || bindingDefaultsOf(declaration, identifier.getText()).some((fallback) => forwards(fallback));
    });
};

/**
 * True when `node` is scoped by a server-trusted `ctx` value — directly, through
 * one local `const` hop (symmetric with {@link isArgumentDerived}), or through a
 * locally-bound ctx identity composed into the key. A storage/kv key such as
 * `${ctx.auth.userId}/${args.name}` references *both* `args` and `ctx`; the IDOR
 * sinks treat any key that reaches `ctx` — even via `const k = scoped; … k` — as
 * scoped rather than attacker-controlled, so a correctly-prefixed key is not
 * flagged.
 *
 * The recommended remediation is usually written through an intermediate binding —
 * `const userId = ctx.auth.userId; … `${userId}/${args.name}`` — which puts the
 * ctx value *two* hops from the sink: one hop expands the key to its template, and
 * the identity reaches `ctx` only through the `userId` binding. So after the direct
 * and single-hop checks, each value-identifier composed into the key is followed
 * one hop to its own initializer, treating a key built from a ctx-derived local as
 * scoped. This only ever *suppresses* a finding (a fail-safe under-report), never
 * introduces one.
 */
export const isScopedByContext = (node: TsNode): boolean => {
    if (referencesContext(node)) {
        return true;
    }

    const initializer = trustedInitializerOf(node);

    if (initializer !== undefined && referencesContext(initializer)) {
        return true;
    }

    // Follow each value-identifier composed into the (expanded) key one hop to its
    // own initializer — `${userId}/…` reaches ctx via `const userId = ctx.*`.
    const composed = initializer ?? node;
    const identifiers = Node.isIdentifier(composed) ? [composed] : composed.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some((identifier) => {
        const boundInitializer = trustedInitializerOf(identifier);

        return boundInitializer !== undefined && referencesContext(boundInitializer);
    });
};

/**
 * Whether `node` is scoped to a key source the caller cannot choose: the caller's
 * identity, or a database read bound to that identity (an owned record's field read
 * off `ctx.db…findFirst({ where: { ownerId: ctx.auth.userId } })`). A row fetched by
 * a caller-supplied id (`ctx.db.get("files", args.id)`) does not scope a key: the
 * caller picked the row. It runs the same direct, one-hop and composed-local stages
 * as {@link isScopedByContext}, asking {@link referencesScopedKeySource} instead of
 * {@link referencesContext}. Only the IDOR sinks (kv, storage, container keys) use
 * it: a key built from an env value (`${ctx.env.PREFIX}/${args.key}`) or `ctx.now`
 * is still shared or caller-chosen, so it is not scoped. Browser URLs keep the
 * broader check, because a server-pinned host (`${ctx.env.CDN}/…`) is exactly the
 * safe shape there.
 */
export const isScopedByIdentity = (node: TsNode): boolean => {
    // A caller value on any fallback path (`row?.storageKey ?? args.key`) is the key whenever the scoped
    // side is missing, so nothing the key also reads can scope it, unless every alternative lands
    // after an identity prefix (`${ctx.auth.userId}/${args.key ?? args.other}`).
    const expanded = trustedInitializerOf(node) ?? node;
    const hasCallerFallback = (within: TsNode): boolean =>
        valueIdentifiersOf(within).some(
            (identifier) =>
                isAlternativeOf(identifier, within) && reachesArgsWithinOneHop(outermostChainOf(identifier)) && !followsIdentityPrefix(identifier, within),
        );
    // A local composed into the key carries its own fallback (`${selected}/${args.name}` with `selected = row.ownerId ??
    // args.key`). Each one is placed in the whole key, not only in the local: `${args.t}/${prefix}` with `prefix =
    // \`${uid}/${args.a ?? args.b}\`` has a caller segment ahead of the identity.
    const composedFallback = valueIdentifiersOf(expanded).some((reference) => {
        const initializer = trustedInitializerOf(reference);

        return (
            initializer !== undefined &&
            valueIdentifiersOf(initializer).some(
                (identifier) =>
                    isAlternativeOf(identifier, initializer) &&
                    reachesArgsWithinOneHop(outermostChainOf(identifier)) &&
                    !followsIdentityPrefix(identifier, expanded, reference),
            )
        );
    });

    if (hasCallerFallback(expanded) || composedFallback) {
        return false;
    }

    if (referencesScopedKeySource(node, node)) {
        return true;
    }

    if (bindingScopesKey(node, node)) {
        return true;
    }

    const composed = trustedInitializerOf(node) ?? node;
    const identifiers = Node.isIdentifier(composed) ? [composed] : composed.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some(
        // `args.key ?? uid` is the caller's key whenever one is sent, whatever `uid` holds, and a value passed into a
        // `ctx.db` call does not scope the key either: only an identity-bound read does, through the direct branch.
        (identifier) => !isAlternativeOf(identifier, composed) && !insideDatabaseCallWithin(identifier, composed) && bindingScopesKey(identifier, composed),
    );
};

/**
 * True when `node` is, or textually contains, a value reference to the `httpAction`
 * request parameter `requestName`. The request-rooted analog of
 * {@link referencesArgs}: catches `request.headers.get("x")`,
 * `new URL(request.url).searchParams.get("q")`, and `await request.json()`, which
 * the `args`-rooted feeders can't see (an HTTP handler receives a raw `Request`,
 * not the validated `args` object).
 */
export const referencesRequestInput = (node: TsNode, requestName: string): boolean => referencesBinding(node, requestName);

/**
 * True when `node` is derived from the `httpAction` request parameter — directly,
 * through one local `const` hop (`const h = request.headers; h.get("x")`), or
 * through one hop on the *root* of a member access (`const body = await
 * request.json(); … body.tag`). Symmetric with {@link isArgumentDerived}, plus the
 * member-root hop so a reflected request *body* value (always bound to a `const`
 * before its fields are read) is reached. Deliberately bounded to a single hop —
 * an unreached case is a fail-safe under-report, not a false negative that matters.
 */
export const isRequestInputDerived = (node: TsNode, requestName: string): boolean => {
    if (referencesRequestInput(node, requestName)) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    if (initializer !== undefined && referencesRequestInput(initializer, requestName)) {
        return true;
    }

    const root = memberAccessRootIdentifier(node);

    if (root !== undefined) {
        const rootInitializer = singleHopInitializer(root);

        return rootInitializer !== undefined && referencesRequestInput(rootInitializer, requestName);
    }

    return false;
};

/**
 * Whether a sink's key is read off a row that the handler has already checked against the caller's
 * identity, before the sink. `sinkCall` is the sink call, `key` its key argument, and `F` the innermost
 * function containing the sink. The rule holds only when all its parts hold; every other shape
 * reports.
 *
 * (R) The row. `key` (or, when it is a bare identifier, its one-hop `const` initializer) is an access
 * chain with at least one level, rooted at identifier `R`. `R` is a single-identifier `const` directly
 * in `F`, initialised by (`await`) a `ctx.db` read.
 *
 * (a) An identity-bound guard, in one of two forms.
 *
 * Helper guard: an expression statement `await h(…)` or `h(…)`. `h` is an app function (see
 * {@link appFunctionOf}) reached by one level only, not through another helper. Exactly one
 * argument is the handler's ctx; `h`'s parameter at that position is a plain identifier `P`. `h`'s
 * own body (not a nested function) contains a read `P.db…(…)` whose arguments contain a `P.auth…`
 * chain, and a `throw`. If `h` is `async` or may return a Promise, the call is awaited.
 *
 * Inline guard: `const g = await ctx.db…(…)` in `F`, whose read arguments reference `ctx.auth`
 * (see {@link isIdentityBoundRead}), followed directly by `if (!g | g === null | g == null |
 * g == undefined) { … }` with no `else`. The branch's last statement (the block's, or the branch itself)
 * is a `throw` or a `return`. A read answers `null` on a miss, so `g === undefined` is no check.
 *
 * The helper's ctx and row parameters have no default and are never reassigned, and the identity it
 * reads is not a fallback or a conditional branch.
 *
 * (d) The row keeps its key. No use of `R` can change the value at the key's path: no write to it or
 * to an object holding it, and no object holding it handed to a call, aliased or used as `this`.
 *
 * (b) Tied to the row. For a helper guard, an argument other than the ctx references `R`. For an
 * inline guard, the read's arguments reference `R`. A reference is a symbol match, not a spelling
 * match.
 *
 * (c) Dominates and is enforced. The guard statement is a direct child of a `Block` that contains the
 * sink, and comes before the statement of that block that contains the sink. The guard is not inside a
 * nested function, loop, `if`, `switch` case, `catch`, or a `try` with a `catch` unless the sink is in
 * that same `try` block. An inline guard is enforced only by its `if`, and a helper guard only by
 * its `throw`; neither return value is inspected.
 *
 * Used by the identity-scoped IDOR feeders only, in addition to {@link isScopedByIdentity}.
 */
export const isGuardedByIdentityCheck = (sinkCall: CallExpression, key: TsNode): boolean => {
    const enclosing = enclosingFunctionOf(sinkCall);
    const guarded = rowDeclarationOf(key);

    if (enclosing === undefined || guarded === undefined || enclosingFunctionOf(guarded.row)?.compilerNode !== enclosing.compilerNode) {
        return false;
    }

    const { keyPath, row } = guarded;
    const rowName = row.getNameNode();
    const guards: RowGuard[] = [];
    let child: TsNode = sinkCall;

    for (let ancestor = sinkCall.getParent(); ancestor !== undefined && ancestor.compilerNode !== enclosing.compilerNode; ancestor = ancestor.getParent()) {
        if (Node.isBlock(ancestor)) {
            const statements = ancestor.getStatements();
            const index = statements.findIndex((statement) => statement.compilerNode === child.compilerNode);

            guards.push(...(index > 0 ? precedingGuardsOf(statements, index, row, enclosing, sinkCall) : []));
        }

        child = ancestor;
    }

    if (!Node.isIdentifier(rowName)) {
        return false;
    }

    const rowUses = usesOfLocal(rowName).filter((use) => mayRunBefore(use, sinkCall, enclosing));

    // A `const` row's fields stay writable: `row.key = args.key`, `row.channelId = args.channelId` or
    // `Object.assign(row, args)` replaces what a guard vouched for, in the handler or in a guard helper. The row handed
    // to any verified guard helper is judged by that helper's uses, against each guard's paths, so two stacked guards
    // (`assertMember(ctx, row); assertOwner(ctx, row)`) do not count each other's call as an escape. One guard whose
    // values all survive is enough.
    const helperArguments = new Set(guards.flatMap((guard) => guard.helperArguments ?? []));
    const helperUses = guards.flatMap((guard) => guard.helperUses ?? []);

    return guards.some((guard) => {
        const guardedPaths = guardedPathsOf(keyPath, guard.guardedPaths);

        return (
            rowUses.every((use) => helperArguments.has(accessChainFrom(use).node) || keepsGuardedValues(use, guardedPaths)) &&
            helperUses.every(({ prefix, use }) => keepsGuardedValues(use, guardedPaths, prefix))
        );
    });
};

export { appFunctionOf };
