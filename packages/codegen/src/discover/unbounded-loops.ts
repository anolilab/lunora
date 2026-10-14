import type { DoStatement, Expression, ForStatement, Node as TsNode, Project, WhileStatement } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { UnboundedLoopIR } from "../ir";
import { collectNodeRows, isFunctionLike, isSameNode, unwrapExpression } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { escapes, jumpsIn, jumpTargetOf, sharesFunctionWith } from "./jumps";

/** The loop forms that can be written literal-infinite. */
type Loop = DoStatement | ForStatement | WhileStatement;

/** `signal.throwIfAborted()` — the standard way an `AbortSignal` ends a loop, by throwing out of it. */
const isAbortCheck = (node: TsNode): boolean => {
    const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;

    return Node.isPropertyAccessExpression(callee) && callee.getName() === "throwIfAborted";
};

/**
 * `true` when the loop has a statically visible way out: a `break` bound to
 * it, a `break`/`continue` to a label outside it, a `return`/`throw` leaving
 * its function, or a `signal.throwIfAborted()` check. A `continue` to the loop
 * itself, a jump within a nested loop or `switch`, and anything in a nested
 * callback keep it turning.
 */
const hasExit = (loop: Loop): boolean =>
    jumpsIn(loop).some((jump) => escapes(jump, loop) || (Node.isBreakStatement(jump) && isSameNode(jumpTargetOf(jump), loop))) ||
    loop.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => isAbortCheck(call) && sharesFunctionWith(call, loop));

/**
 * `true` when the loop `yield`s from its own generator — `while (true) yield
 * next++` is a lazy infinite sequence, paused at every `yield` and pulled only
 * as far as its consumer asks, not a hang.
 */
const yieldsFromLoop = (loop: Loop): boolean =>
    loop.getDescendantsOfKind(SyntaxKind.YieldExpression).some((expression) => sharesFunctionWith(expression, loop));

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

/** Which loop form `loop` is. */
const kindOf = (loop: Loop): UnboundedLoopIR["kind"] => {
    if (Node.isDoStatement(loop)) {
        return "do";
    }

    return Node.isWhileStatement(loop) ? "while" : "for";
};

/** The {@link UnboundedLoopIR} for a loop that is always on and has no exit, else `undefined`. */
const rowOf = (loop: Loop, file: string): UnboundedLoopIR | undefined => {
    const condition = conditionOf(loop);
    // Only `for (;;)` may omit its condition, and it is always on; `as`,
    // `satisfies`, `!` and parentheses do not change a literal `true`.
    const alwaysOn = condition === undefined || Node.isTrueLiteral(unwrapExpression(condition));

    if (!alwaysOn || hasExit(loop) || yieldsFromLoop(loop)) {
        return undefined;
    }

    const scope = callSiteScopeOf(loop);

    // "Module scope" inside a function is code attribution cannot place — a
    // class method, say — so nothing proves it ever runs.
    if (scope.kind === "module" && loop.getFirstAncestor(isFunctionLike) !== undefined) {
        return undefined;
    }

    return { file, kind: kindOf(loop), line: loop.getStartLineNumber(), scope };
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
const discoverUnboundedLoops = (project: Project, lunoraDirectory: string): UnboundedLoopIR[] =>
    // One walk per loop kind, then back into source order.
    [
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.WhileStatement, rowOf),
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.ForStatement, rowOf),
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.DoStatement, rowOf),
    ].toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

export default discoverUnboundedLoops;
