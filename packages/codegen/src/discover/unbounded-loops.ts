import type { BreakStatement, DoStatement, Expression, ForStatement, Node as TsNode, Project, WhileStatement } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { UnboundedLoopIR } from "../ir";
import { collectNodeRows, isFunctionLike } from "./ast";
import { callSiteScopeOf } from "./attribution";

/** The loop forms that can be written literal-infinite. */
type Loop = DoStatement | ForStatement | WhileStatement;

/** Loop and `switch` statements — what an unlabeled `break` binds to. */
const isBreakTarget = (node: TsNode): boolean =>
    Node.isDoStatement(node) ||
    Node.isForInStatement(node) ||
    Node.isForOfStatement(node) ||
    Node.isForStatement(node) ||
    Node.isSwitchStatement(node) ||
    Node.isWhileStatement(node);

/**
 * What a `break` leaves: an unlabeled one binds to the nearest enclosing loop
 * or `switch`, a labeled one to the statement its label wraps. `undefined`
 * when a function boundary or the file ends first — a `break` never crosses a
 * function, so such a target belongs to a construct inside the break's own
 * declaration.
 */
const breakTargetOf = (statement: BreakStatement): TsNode | undefined => {
    const label = statement.getLabel()?.getText();

    let child: TsNode = statement;

    for (;;) {
        const parent = child.getParent();

        if (parent === undefined || Node.isSourceFile(parent) || isFunctionLike(parent)) {
            return undefined;
        }

        if (label === undefined ? isBreakTarget(parent) : Node.isLabeledStatement(parent) && parent.getLabel().getText() === label) {
            return parent;
        }

        child = parent;
    }
};

/**
 * `true` when `node` sits strictly inside `loop` — the loop itself does not
 * count, so a `break` bound to `loop` or to a labeled block wrapping it reads
 * as an exit while one bound to a nested loop or `switch` does not. Compared
 * by compiler node, which is unique per AST position.
 */
const isInsideLoop = (node: TsNode, loop: TsNode): boolean => {
    let child: TsNode = node;

    for (;;) {
        const parent = child.getParent();

        if (parent === undefined) {
            return false;
        }

        if (parent.compilerNode === loop.compilerNode) {
            return true;
        }

        child = parent;
    }
};

/**
 * `true` when walking up from `statement` reaches `loop` before any function
 * boundary: the statement leaves the function the loop lives in, so it leaves
 * the loop with it. A `return`/`throw` inside a nested callback only leaves the
 * callback — the loop keeps turning — so it stops at that boundary and reads
 * as no exit.
 */
const escapesThrough = (statement: TsNode, loop: TsNode): boolean => {
    let child: TsNode = statement;

    for (;;) {
        const parent = child.getParent();

        if (parent === undefined || Node.isSourceFile(parent) || isFunctionLike(parent)) {
            return false;
        }

        if (parent.compilerNode === loop.compilerNode) {
            return true;
        }

        child = parent;
    }
};

/**
 * `true` when the loop has a statically visible way out: a `break` bound to
 * this loop (or to a labeled block wrapping it), or a `return`/`throw` that
 * leaves the function. A `break` bound to a nested loop or `switch` leaves
 * only that inner construct, and a `break` in a nested declaration leaves
 * nothing of this loop.
 */
const hasExit = (loop: Loop): boolean => {
    for (const breakStatement of loop.getDescendantsOfKind(SyntaxKind.BreakStatement)) {
        const target = breakTargetOf(breakStatement);

        if (target !== undefined && !isInsideLoop(target, loop)) {
            return true;
        }
    }

    return [...loop.getDescendantsOfKind(SyntaxKind.ReturnStatement), ...loop.getDescendantsOfKind(SyntaxKind.ThrowStatement)].some((statement) =>
        escapesThrough(statement, loop),
    );
};

/**
 * `true` when the loop `yield`s from its own generator — `while (true) yield
 * next++` is a lazy infinite sequence, paused at every `yield` and pulled only
 * as far as its consumer asks, not a hang. A `yield` in a nested generator does
 * not suspend this loop.
 */
const yieldsFromLoop = (loop: Loop): boolean => loop.getDescendantsOfKind(SyntaxKind.YieldExpression).some((expression) => escapesThrough(expression, loop));

/**
 * Literal `true` with parentheses unwrapped — `while ((true))` is as
 * unbounded as `while (true)`.
 */
const isTrueCondition = (condition: Expression | undefined): boolean => {
    let current: Expression | undefined = condition;

    while (current !== undefined && Node.isParenthesizedExpression(current)) {
        current = current.getExpression();
    }

    return current !== undefined && Node.isTrueLiteral(current);
};

/**
 * The loop's condition expression: while/do are `ExpressionedNode`s
 * (`getExpression`), a `for` head may omit it (`getCondition`).
 */
const conditionOf = (loop: Loop): Expression | undefined => {
    if (Node.isDoStatement(loop) || Node.isWhileStatement(loop)) {
        return loop.getExpression();
    }

    return loop.getCondition();
};

/** The {@link UnboundedLoopIR} for a loop that is always on and has no exit, else `undefined`. */
const rowOf =
    (kind: UnboundedLoopIR["kind"]) =>
    (loop: Loop, file: string): UnboundedLoopIR | undefined => {
        const condition = conditionOf(loop);
        // Only `for (;;)` may omit its condition; `while`/`do` always carry one.
        const alwaysOn = condition === undefined ? kind === "for" : isTrueCondition(condition);

        return !alwaysOn || hasExit(loop) || yieldsFromLoop(loop) ? undefined : { file, kind, line: loop.getStartLineNumber(), scope: callSiteScopeOf(loop) };
    };

/**
 * Discover the literal-infinite loops of `lunora/` with no statically
 * reachable exit — `while (true)`, `for (;;)` / `for (; true;)`,
 * `do { … } while (true)` — one {@link UnboundedLoopIR} per offending loop,
 * none when the loop can leave (see `hasExit`). A loop guarded by a condition
 * that is not a literal `true` is not recorded: it may be bounded by state the
 * walk cannot read, and the lint's claim is that it cannot cry wolf. Loops in
 * nested declarations are attributed through {@link callSiteScopeOf} like any
 * other site, so the lint can gate them on reachability.
 */
const discoverUnboundedLoops = (project: Project, lunoraDirectory: string): UnboundedLoopIR[] => [
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.WhileStatement, rowOf("while")),
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.ForStatement, rowOf("for")),
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.DoStatement, rowOf("do")),
];

export default discoverUnboundedLoops;
