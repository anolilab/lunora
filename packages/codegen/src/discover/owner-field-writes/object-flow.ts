/**
 * Where an object goes once bound: the expressions that still evaluate to (part
 * of) it, and the bindings that take it. The syntax half of
 * `ImplTaint.isCompromised`, which judges what happens at the end of the climb.
 */
import type { BindingElement, Node as TsNode, ParameterDeclaration, Type, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isConstDeclaration, outermostValueWrapper, unwrapExpression } from "../ast";
import { CALLBACK_RESULT_METHODS } from "../context-root";
import { isLibraryGlobal, isSameNode } from "./read-only-use";

/** A binding whose object a later statement may change: a variable, a parameter, or one element of a destructuring. */
type ObjectBinding = BindingElement | ParameterDeclaration | VariableDeclaration;

/** Array methods whose result holds the receiver's own elements (`rows.find(…)`, `rows[0]` by another name). */
const ELEMENT_RESULT_METHODS = new Set<string>(["at", "concat", "filter", "find", "findLast", "flat", "reverse", "slice", "sort", "toReversed", "toSorted"]);

/** Platform statics whose result holds their argument's own members or elements. */
const MEMBER_RESULT_STATICS = new Map<string, ReadonlySet<string>>([
    ["Array", new Set(["from", "of"])],
    ["Object", new Set(["entries", "values"])],
]);

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

/** The identifier-named elements of a destructuring pattern, nested ones included. */
const bindingIdentifiersOf = (binding: ObjectBinding): BindingElement[] =>
    binding
        .getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .filter((element) => Node.isIdentifier(element.getNameNode()));

/** The variable declaration `node` (through wrappers) is the whole initializer of, or the loop variable of a `for…of` over it. */
const receivingDeclarationOf = (node: TsNode): VariableDeclaration | undefined => {
    const value = outermostValueWrapper(node);
    const parent = value.getParent();

    if (Node.isVariableDeclaration(parent)) {
        return isSameNode(parent.getInitializer(), value) ? parent : undefined;
    }

    const initializer = Node.isForOfStatement(parent) && parent.getExpression() === value ? parent.getInitializer() : undefined;

    return Node.isVariableDeclarationList(initializer) ? initializer.getDeclarations()[0] : undefined;
};

/**
 * The bindings that take (part of) `node`'s object, which the flow walk follows
 * as aliases: a `const` bound to it (`const alias = row`, `const m = row.meta`),
 * the loop variable of a `for…of` over it, and every element of a destructuring
 * of it, object or array, nested ones included (`const { meta } = row`,
 * `const [owner] = members`, `for (const { meta } of rows)`), whose
 * object-valued members are the row's own nested objects. `undefined` when
 * `node` is no such initializer; a `let` / `var` bound to it whole is not
 * followed, and the caller fails closed.
 */
const aliasBindingsOf = (node: TsNode): ObjectBinding[] | undefined => {
    const declaration = receivingDeclarationOf(node);

    if (declaration === undefined) {
        return undefined;
    }

    if (!Node.isIdentifier(declaration.getNameNode())) {
        return bindingIdentifiersOf(declaration);
    }

    const isLoopVariable = Node.isForOfStatement(declaration.getParent().getParent());

    return isLoopVariable || isConstDeclaration(declaration) ? [declaration] : undefined;
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

/** Whether `call` is a call of one of `methods` on a receiver (`rows.find(…)`), and that receiver is `receiver` when given. */
const isMethodCall = (call: TsNode | undefined, methods: ReadonlySet<string>, receiver?: TsNode): boolean => {
    const callee = Node.isCallExpression(call) ? unwrapExpression(call.getExpression()) : undefined;

    return Node.isPropertyAccessExpression(callee) && methods.has(callee.getName()) && (receiver === undefined || callee.getExpression() === receiver);
};

/** Whether `call` is a {@link MEMBER_RESULT_STATICS} call on the platform global (`Object.values(rows)`). */
const isMemberResultStatic = (call: TsNode | undefined): boolean => {
    const callee = Node.isCallExpression(call) ? unwrapExpression(call.getExpression()) : undefined;
    const root = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;

    return (
        Node.isPropertyAccessExpression(callee) &&
        Node.isIdentifier(root) &&
        MEMBER_RESULT_STATICS.get(root.getText())?.has(callee.getName()) === true &&
        isLibraryGlobal(root)
    );
};

/** The call whose result a callback's returned `value` becomes: an inline callback of a {@link CALLBACK_RESULT_METHODS} method. */
const callbackResultCallOf = (value: TsNode): TsNode | undefined => {
    const parent = value.getParent();
    const returned = Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === value);
    const callback = returned ? value.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) : undefined;
    const call = callback === undefined ? undefined : outermostValueWrapper(callback).getParent();

    return Node.isCallExpression(call) && call.getArguments().includes(outermostValueWrapper(callback as TsNode)) && isMethodCall(call, CALLBACK_RESULT_METHODS)
        ? call
        : undefined;
};

/**
 * One step up from `node` to the expression that still evaluates to (part of)
 * the same object, or `undefined` when `node`'s value goes no further: a member
 * path (`row.meta`, `rows[0]`), `await`, `??` / `||` / `&&`, either branch of
 * `?:`, a container holding it (`[row]`, `{ r: row }`, `{ ...row }`), an
 * element-returning method (`rows.find(…)`, `rows.slice()`), a member-returning
 * static (`Object.values(rows)`), or the result of a callback-result method its
 * callback returns it to (`rows.map((r) => r)`).
 */
/** One {@link objectContinuation} step through a member access on `value`: the member path, or an element-returning method's result. */
const memberContinuation = (access: TsNode, value: TsNode): TsNode | undefined => {
    if (!(Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) || access.getExpression() !== value) {
        return undefined;
    }

    const member = outermostValueWrapper(access);
    const holder = member.getParent();

    if (!Node.isCallExpression(holder) || holder.getExpression() !== member) {
        return access;
    }

    return isMethodCall(holder, ELEMENT_RESULT_METHODS, value) ? holder : undefined;
};

/** One {@link objectContinuation} step through an operator: `await`, `??` / `||` / `&&`, a branch of `?:`. */
const operatorContinuation = (parent: TsNode, value: TsNode): TsNode | undefined => {
    if (Node.isAwaitExpression(parent)) {
        return parent;
    }

    if (Node.isConditionalExpression(parent)) {
        return parent.getCondition() === value ? undefined : parent;
    }

    const operator = Node.isBinaryExpression(parent) ? parent.getOperatorToken().getKind() : undefined;

    return operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken || operator === SyntaxKind.AmpersandAmpersandToken
        ? parent
        : undefined;
};

/** One {@link objectContinuation} step into a container holding `value`: `[row]`, `{ r: row }`, `{ row }`, `{ ...row }`, `[...rows]`. */
const containerContinuation = (parent: TsNode, value: TsNode): TsNode | undefined => {
    if (Node.isArrayLiteralExpression(parent)) {
        return parent;
    }

    const isSlot =
        Node.isSpreadElement(parent) ||
        Node.isSpreadAssignment(parent) ||
        Node.isShorthandPropertyAssignment(parent) ||
        (Node.isPropertyAssignment(parent) && isSameNode(parent.getInitializer(), value));
    const literal = isSlot ? parent.getParent() : undefined;

    return Node.isArrayLiteralExpression(literal) || Node.isObjectLiteralExpression(literal) ? literal : undefined;
};

/**
 * One step up from `node` to the expression that still evaluates to (part of)
 * the same object, or `undefined` when `node`'s value goes no further: a member
 * path (`row.meta`, `rows[0]`), `await`, `??` / `||` / `&&`, either branch of
 * `?:`, a container holding it (`[row]`, `{ r: row }`, `{ ...row }`), an
 * element-returning method (`rows.find(…)`, `rows.slice()`), a member-returning
 * static (`Object.values(rows)`), or the result of a callback-result method its
 * callback returns it to (`rows.map((r) => r)`).
 */
const objectContinuation = (node: TsNode): TsNode | undefined => {
    const value = outermostValueWrapper(node);
    const parent = value.getParent();

    if (parent === undefined) {
        return undefined;
    }

    const isStaticArgument = Node.isCallExpression(parent) && parent.getArguments().includes(value) && isMemberResultStatic(parent);

    return (
        memberContinuation(parent, value) ??
        operatorContinuation(parent, value) ??
        containerContinuation(parent, value) ??
        (isStaticArgument ? parent : callbackResultCallOf(value))
    );
};

export { aliasBindingsOf, bindingIdentifiersOf, ELEMENT_RESULT_METHODS, isMethodCall, isPrimitiveType, objectContinuation, RECEIVER_ITERATING_METHODS };
export type { ObjectBinding };
