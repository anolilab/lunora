import type { BreakStatement, ContinueStatement, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isFunctionLike, isSameNode } from "./ast";

/** Loops — what an unlabeled `continue` binds to. */
const isLoop = (node: TsNode): boolean =>
    Node.isDoStatement(node) || Node.isForInStatement(node) || Node.isForOfStatement(node) || Node.isForStatement(node) || Node.isWhileStatement(node);

/**
 * What a `break`/`continue` transfers to: an unlabeled `break` binds to the
 * nearest loop or `switch`, an unlabeled `continue` to the nearest loop, and a
 * labeled one to the statement its label wraps. `undefined` when a function
 * boundary comes first — a jump never crosses a function.
 */
const jumpTargetOf = (jump: BreakStatement | ContinueStatement): TsNode | undefined => {
    const label = jump.getLabel()?.getText();
    const bindsTo = (node: TsNode): boolean => {
        if (label !== undefined) {
            return Node.isLabeledStatement(node) && node.getLabel().getText() === label;
        }

        return isLoop(node) || (Node.isBreakStatement(jump) && Node.isSwitchStatement(node));
    };
    const target = jump.getFirstAncestor((ancestor) => isFunctionLike(ancestor) || bindsTo(ancestor));

    return target === undefined || isFunctionLike(target) ? undefined : target;
};

/**
 * `true` when `node` runs in the same function as `container`, inside it:
 * walking up reaches the container before any function boundary.
 */
const sharesFunctionWith = (node: TsNode, container: TsNode): boolean =>
    isSameNode(
        node.getFirstAncestor((ancestor) => isSameNode(ancestor, container) || isFunctionLike(ancestor)),
        container,
    );

/** `true` when `node` is `container` or sits inside it. */
const isWithin = (node: TsNode, container: TsNode): boolean =>
    isSameNode(node, container) || node.getFirstAncestor((ancestor) => isSameNode(ancestor, container)) !== undefined;

/**
 * `true` when `jump` carries control out past the end of `container`: a
 * `return`/`throw` in the container's own function, or a `break`/`continue`
 * whose target lies outside it. A `continue` bound to a loop inside the
 * container, or a `break` out of a nested `switch`, stays within.
 */
const escapes = (jump: TsNode, container: TsNode): boolean => {
    if (Node.isReturnStatement(jump) || Node.isThrowStatement(jump)) {
        return isSameNode(jump, container) || sharesFunctionWith(jump, container);
    }

    if (Node.isBreakStatement(jump) || Node.isContinueStatement(jump)) {
        const target = jumpTargetOf(jump);

        return target !== undefined && !isWithin(target, container);
    }

    return false;
};

/** Every `break`/`continue`/`return`/`throw` — statements that can carry control past the end of what holds them — at or below `node`. */
const jumpsIn = (node: TsNode): TsNode[] => [
    ...(Node.isBreakStatement(node) || Node.isContinueStatement(node) || Node.isReturnStatement(node) || Node.isThrowStatement(node) ? [node] : []),
    ...node.getDescendantsOfKind(SyntaxKind.BreakStatement),
    ...node.getDescendantsOfKind(SyntaxKind.ContinueStatement),
    ...node.getDescendantsOfKind(SyntaxKind.ReturnStatement),
    ...node.getDescendantsOfKind(SyntaxKind.ThrowStatement),
];

/**
 * `true` when control may leave `statement` other than by falling off its end —
 * so whatever follows it in the same block may not run. Exact rather than
 * kind-based: `if (log) console.log(…)` and a `for … of` with no jump fall
 * through, while a `return` buried in a `try`, `switch`, block or labeled
 * statement does not.
 */
const mayLeave = (statement: TsNode): boolean => jumpsIn(statement).some((jump) => escapes(jump, statement));

export { escapes, jumpsIn, jumpTargetOf, mayLeave, sharesFunctionWith };
