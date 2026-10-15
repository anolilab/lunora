/**
 * Where a `break`/`continue`/`return`/`throw` takes control: a port of the
 * codegen analysis `discover/jumps.ts` from ts-morph to ESTree.
 */
import { descendants, firstAncestor, isFunctionLike } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */

/** What an unlabeled `continue` binds to. */
const LOOP_TYPES = new Set(["DoWhileStatement", "ForInStatement", "ForOfStatement", "ForStatement", "WhileStatement"]);

const JUMP_TYPES = new Set(["BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement"]);

/**
 * What a `break`/`continue` transfers to: an unlabeled `break` binds to the
 * nearest loop or `switch`, an unlabeled `continue` to the nearest loop, a
 * labeled `break` to the statement its label wraps, and a labeled `continue`
 * to the LOOP its label names — it resumes that loop rather than leaving it,
 * so `l: while (true) { continue l; }` keeps turning. `undefined` when a
 * function boundary comes first.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} jump A `BreakStatement` or `ContinueStatement`.
 * @returns {AstNode} The statement control transfers to.
 */
const jumpTargetOf = (tree, jump) => {
    const label = jump.label?.name;
    const target = firstAncestor(tree, jump, (ancestor) => {
        if (isFunctionLike(ancestor)) {
            return true;
        }

        if (label !== undefined) {
            return ancestor.type === "LabeledStatement" && ancestor.label.name === label;
        }

        return LOOP_TYPES.has(ancestor.type) || (jump.type === "BreakStatement" && ancestor.type === "SwitchStatement");
    });

    if (target === undefined || isFunctionLike(target)) {
        return undefined;
    }

    if (jump.type === "ContinueStatement" && target.type === "LabeledStatement") {
        let { body } = target;

        while (body.type === "LabeledStatement") {
            body = body.body;
        }

        return body;
    }

    return target;
};

/**
 * `true` when `node` runs in the same function as `container`, inside it.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} node A node inside `container`.
 * @param {AstNode} container The enclosing node.
 * @returns {boolean} Whether walking up reaches `container` before any function boundary.
 */
const sharesFunctionWith = (tree, node, container) => firstAncestor(tree, node, (ancestor) => ancestor === container || isFunctionLike(ancestor)) === container;

/**
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} node A node.
 * @param {AstNode} container A node that may hold it.
 * @returns {boolean} Whether `node` is `container` or sits inside it.
 */
const isWithin = (tree, node, container) => node === container || firstAncestor(tree, node, (ancestor) => ancestor === container) !== undefined;

/**
 * `true` when `jump` carries control out past the end of `container`: a
 * `return`/`throw` in the container's own function, or a `break`/`continue`
 * whose target lies outside it.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} jump A jump statement at or below `container`.
 * @param {AstNode} container The statement it may leave.
 * @returns {boolean} Whether it leaves.
 */
const escapes = (tree, jump, container) => {
    if (jump.type === "ReturnStatement" || jump.type === "ThrowStatement") {
        return jump === container || sharesFunctionWith(tree, jump, container);
    }

    const target = jumpTargetOf(tree, jump);

    return target !== undefined && !isWithin(tree, target, container);
};

/**
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} node Where to look.
 * @returns {AstNode[]} Every `break`/`continue`/`return`/`throw` at or below `node`.
 */
const jumpsIn = (tree, node) => descendants(tree, node, (candidate) => JUMP_TYPES.has(candidate.type));

/**
 * `true` when control may leave `statement` other than by falling off its end
 * — so what follows it in the same block may not run. Exact rather than
 * kind-based: `if (log) console.log(…)` falls through, a `return` buried in a
 * `try`, `switch` or labeled block does not.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} statement A statement of a block.
 * @returns {boolean} Whether it may leave.
 */
const mayLeave = (tree, statement) => jumpsIn(tree, statement).some((jump) => escapes(tree, jump, statement));

export { escapes, jumpsIn, jumpTargetOf, mayLeave, sharesFunctionWith };
