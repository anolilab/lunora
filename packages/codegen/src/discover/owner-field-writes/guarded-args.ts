import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { singleHopInitializer } from "../../argument-taint";
import { bindingKeyName, isConstDeclaration, memberAccessOf, unwrapExpression } from "../ast";
import { declarationOf } from "../attribution";
import { contextSurfacePathOf } from "../context-root";

/** The name every handler spells its argument object with (`({ args }) => …`, `({ args: { x } }) => …`). */
const ARGS = "args";

/**
 * The `args` field a node reads: `args.P` / `args?.P` / `args["P"]`, or a
 * destructured `P` out of the handler's `args` (`({ args: { P } })`, or a `const`
 * destructure of `args`). `undefined` for anything else.
 */
const argumentFieldOf = (node: TsNode): string | undefined => {
    const access = memberAccessOf(node);

    if (access !== undefined) {
        const object = unwrapExpression(access.object);

        return Node.isIdentifier(object) && object.getText() === ARGS ? access.member : undefined;
    }

    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const declaration = declarationOf(node);

    if (!Node.isBindingElement(declaration) || declaration.getDotDotDotToken() !== undefined) {
        return undefined;
    }

    const pattern = declaration.getParent();

    if (!Node.isObjectBindingPattern(pattern)) {
        return undefined;
    }

    const holder = pattern.getParent();
    const initializer = isConstDeclaration(holder) ? unwrapExpression(holder.getInitializer()) : undefined;
    const destructuredFromArgs =
        (Node.isBindingElement(holder) && bindingKeyName(holder) === ARGS) || (Node.isIdentifier(initializer) && initializer.getText() === ARGS);

    return destructuredFromArgs ? bindingKeyName(declaration) : undefined;
};

/**
 * The context surfaces that carry the caller's identity. Anything else in the
 * context (`ctx.db`, `ctx.storage`, a helper's return value) is not a proof that a
 * value is the caller's own, so only these count.
 */
const IDENTITY_SURFACES = new Set<string>(["auth", "identity", "user"]);

/** Whether `node` (or its one-hop local initializer) reads a caller-identity surface of the context. */
const isIdentity = (node: TsNode): boolean => {
    const readsIdentity = (candidate: TsNode): boolean => {
        const path = contextSurfacePathOf(candidate);

        return path !== undefined && path.length > 0 && IDENTITY_SURFACES.has(path[0] ?? "");
    };
    const unwrapped = unwrapExpression(node) ?? node;

    if (readsIdentity(unwrapped)) {
        return true;
    }

    const initializer = singleHopInitializer(unwrapped);

    return initializer !== undefined && readsIdentity(initializer);
};

/**
 * The `args` fields a value reads, directly or through up to `hops` local
 * initializers: `organizationIdToUse` reads `organizationId` via
 * `const organizationIdToUse = organizationId || ctx.user.activeOrganization?.id`.
 */
const argumentFieldsOf = (value: TsNode, hops = 2): Set<string> => {
    const fields = new Set<string>();

    for (const node of [value, ...value.getDescendants()]) {
        const field = argumentFieldOf(node);

        if (field !== undefined) {
            fields.add(field);
        }

        const initializer = hops > 0 && Node.isIdentifier(node) ? singleHopInitializer(node) : undefined;

        if (initializer !== undefined) {
            for (const inherited of argumentFieldsOf(initializer, hops - 1)) {
                fields.add(inherited);
            }
        }
    }

    return fields;
};

/**
 * The fields a condition proves equal to the identity when it is FALSE, i.e. when
 * the guard passes. `a !== id` passes only when `a === id`. Under `||` both sides
 * must be false, so both contribute. Under `&&` the right side contributes only
 * when the left is the same argument's truthiness: `args.p && args.p !== id`
 * passes with `args.p` falsy, where the write falls back to the identity anyway,
 * but `args.isAdmin && args.p !== id` says nothing about `args.p`.
 */
const provenFields = (condition: TsNode): string[] => {
    const node = unwrapExpression(condition) ?? condition;

    if (!Node.isBinaryExpression(node)) {
        return [];
    }

    const operator = node.getOperatorToken().getKind();
    const left = node.getLeft();
    const right = node.getRight();

    if (operator === SyntaxKind.BarBarToken) {
        return [...provenFields(left), ...provenFields(right)];
    }

    if (operator === SyntaxKind.AmpersandAmpersandToken) {
        const conjunct = (truthy: TsNode, other: TsNode): string[] => {
            const field = argumentFieldOf(unwrapExpression(truthy) ?? truthy);

            return field === undefined ? [] : provenFields(other).filter((proven) => proven === field);
        };

        return [...conjunct(left, right), ...conjunct(right, left)];
    }

    if (operator !== SyntaxKind.ExclamationEqualsEqualsToken && operator !== SyntaxKind.ExclamationEqualsToken) {
        return [];
    }

    const fields: string[] = [];
    const leftField = argumentFieldOf(unwrapExpression(left) ?? left);
    const rightField = argumentFieldOf(unwrapExpression(right) ?? right);

    if (leftField !== undefined && isIdentity(right)) {
        fields.push(leftField);
    }

    if (rightField !== undefined && isIdentity(left)) {
        fields.push(rightField);
    }

    return fields;
};

/** The name a call is made by: `assertOwned(…)` or `auth.assertOwned(…)`. */
const calleeName = (call: CallExpression): string | undefined => {
    const callee = unwrapExpression(call.getExpression()) ?? call.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
};

/**
 * The fields an `assert*(…)` call proves: a call named `assert…` given an `args`
 * field and, as another argument, the identity. `assertOwnOrganizationId(ctx.user,
 * organizationId)` is the shape. A helper whose name does not say `assert` proves
 * nothing here, so only the name-convention form is recognised.
 */
const assertedFields = (call: CallExpression): string[] => {
    if (!calleeName(call)?.startsWith("assert")) {
        return [];
    }

    const args = call.getArguments();

    return args.flatMap((argument, index) => {
        const field = argumentFieldOf(unwrapExpression(argument) ?? argument);
        const hasIdentity = args.some((other, otherIndex) => otherIndex !== index && isIdentity(other));

        return field !== undefined && hasIdentity ? [field] : [];
    });
};

/**
 * Whether a guard's then-branch ends the handler: a `throw`, or a block whose LAST
 * statement is one. A throw nested deeper (inside a nested `if`, a `try`, or a
 * callback) may not run, so it does not prove anything.
 */
const endsWithThrow = (statement: TsNode): boolean => {
    if (Node.isThrowStatement(statement)) {
        return true;
    }

    if (!Node.isBlock(statement)) {
        return false;
    }

    const last = statement.getStatements().at(-1);

    return last !== undefined && Node.isThrowStatement(last);
};

const isFunctionNode = (node: TsNode): boolean =>
    Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node);

/**
 * Whether `node` runs on every path through `handler`: every ancestor up to the
 * handler is a plain statement container. A branch, loop, `try`, conditional or
 * nested function between them can skip the node, so it is not a proof.
 */
const runsUnconditionally = (node: TsNode, handler: TsNode): boolean => {
    for (let ancestor = node.getParent(); ancestor !== undefined; ancestor = ancestor.getParent()) {
        if (ancestor === handler || ancestor.compilerNode === handler.compilerNode) {
            return true;
        }

        if (!(
            Node.isBlock(ancestor) ||
            Node.isExpressionStatement(ancestor) ||
            Node.isAwaitExpression(ancestor) ||
            Node.isParenthesizedExpression(ancestor) ||
            Node.isVariableStatement(ancestor) ||
            Node.isVariableDeclarationList(ancestor) ||
            Node.isVariableDeclaration(ancestor)
        )) {
            return false;
        }
    }

    return false;
};

/** Fields the handler has proven equal to the identity by `position`: unconditional guards and asserts that finish before it. */
const provenBefore = (handler: TsNode, position: number): Set<string> => {
    const proven = new Set<string>();

    for (const statement of handler.getDescendantsOfKind(SyntaxKind.IfStatement)) {
        if (statement.getEnd() <= position && runsUnconditionally(statement, handler) && endsWithThrow(statement.getThenStatement())) {
            for (const field of provenFields(statement.getExpression())) {
                proven.add(field);
            }
        }
    }

    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getEnd() <= position && runsUnconditionally(call, handler)) {
            for (const field of assertedFields(call)) {
                proven.add(field);
            }
        }
    }

    return proven;
};

/**
 * Whether a write of `written` (one value the write can store) is guarded: every
 * `args` field it reads is proven equal to the server identity earlier in the same
 * handler. A value reading no `args` field is not "guarded" — it is not from
 * `args` at all, and the caller decides that separately.
 */
const isGuardedWrite = (write: TsNode, written: TsNode): boolean => {
    const fields = argumentFieldsOf(written);

    if (fields.size === 0) {
        return false;
    }

    const handler = write.getFirstAncestor(isFunctionNode);

    if (handler === undefined) {
        return false;
    }

    const proven = provenBefore(handler, write.getStart());

    return [...fields].every((field) => proven.has(field));
};

export default isGuardedWrite;
