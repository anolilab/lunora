/**
 * The `unbounded_loop` detector: a literal-infinite loop with no statically
 * reachable exit. A port of the codegen analysis `discover/unbounded-loops.ts`
 * from ts-morph to ESTree.
 */
import { escapes, jumpsIn, jumpTargetOf, sharesFunctionWith } from "./scan-jumps.mjs";
import { descendants, memberName } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */

/**
 * @param {unknown} value A literal's value.
 * @returns {boolean} Whether it is `true` or a non-zero number — what `while (1)` spells.
 */
const isTruthyLiteralValue = (value) => value === true || (typeof value === "number" && value !== 0 && !Number.isNaN(value));

/**
 * A loop condition that can never be false: absent (`for (;;)`), `true`, a
 * non-zero number (`while (1)`), or `!0` (what a minifier writes for `true`).
 * acorn drops parentheses, so `while ((true))` arrives as the bare literal.
 * @param {AstNode} test The loop's condition, or `null`.
 * @returns {boolean} Whether the loop is literally always on.
 */
const isAlwaysTrue = (test) =>
    test === null ||
    (test.type === "Literal" && isTruthyLiteralValue(test.value)) ||
    (test.type === "UnaryExpression" && test.operator === "!" && test.argument.type === "Literal" && test.argument.value === 0);

/**
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is a literal-infinite loop.
 */
const isAlwaysOnLoop = (node) =>
    (node.type === "WhileStatement" || node.type === "DoWhileStatement" || node.type === "ForStatement") && isAlwaysTrue(node.test);

/**
 * `signal.throwIfAborted()` — the standard way an `AbortSignal` ends a loop, by throwing out of it.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is that call.
 */
const isAbortCheck = (node) => node.type === "CallExpression" && memberName(node.callee) === "throwIfAborted";

/**
 * `true` when the loop has a statically visible way out: a `break` bound to
 * it, a `break`/`continue` to a label outside it, a `return`/`throw` leaving
 * its function, or a `signal.throwIfAborted()` check in its own function. A
 * `continue` to the loop itself, a jump within a nested loop or `switch`, and
 * anything in a nested callback keep it turning. An `await` is not an exit:
 * it yields, and the loop resumes.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} loop The loop.
 * @returns {boolean} Whether it can leave.
 */
const hasExit = (tree, loop) =>
    jumpsIn(tree, loop).some((jump) => escapes(tree, jump, loop) || (jump.type === "BreakStatement" && jumpTargetOf(tree, jump) === loop)) ||
    descendants(tree, loop, isAbortCheck).some((call) => sharesFunctionWith(tree, call, loop));

/**
 * `true` when the loop `yield`s from its own generator — a lazy infinite
 * sequence, pulled only as far as its consumer asks, not a hang.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} loop The loop.
 * @returns {boolean} Whether it yields from its own function.
 */
const yieldsFromLoop = (tree, loop) =>
    descendants(tree, loop, (node) => node.type === "YieldExpression").some((expression) => sharesFunctionWith(tree, expression, loop));

/**
 * @param {AstNode} loop A literal-infinite loop.
 * @returns {string} How it is written, for the message.
 */
const loopKindOf = (loop) => {
    // `raw` spells a literal as written (`1`, `true`); `!0` reads as `true`.
    const condition = loop.test?.type === "Literal" ? String(loop.test.raw) : "true";

    if (loop.type === "DoWhileStatement") {
        return `do … while (${condition})`;
    }

    return loop.type === "WhileStatement" ? `while (${condition})` : "for (;;)";
};

export { hasExit, isAlwaysOnLoop, loopKindOf, yieldsFromLoop };
