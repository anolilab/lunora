/**
 * Whether a call runs on every pass of its handler: a port of the codegen
 * `conditionalPosition` / `isConditionalSite` (`discover/call-edges.ts`) from
 * ts-morph to ESTree.
 */
import { mayLeave } from "./scan-jumps.mjs";
import { descendants, firstAncestor, isFunctionLike } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */

/** Assignments whose right side runs only when the left one allows it. */
const LOGICAL_ASSIGNMENTS = new Set(["&&=", "??=", "||="]);

/**
 * `true` when `node` is a link of an optional chain — evaluated only when no
 * earlier `?.` short-circuited: some link down its callee/object spine is
 * optional. A parenthesised chain (`(a?.b).c`) ends at its `ChainExpression`.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it sits in an optional chain.
 */
const inOptionalChain = (node) => {
    for (
        let link = node;
        link?.type === "CallExpression" || link?.type === "MemberExpression";
        link = link.type === "CallExpression" ? link.callee : link.object
    ) {
        if (link.optional === true) {
            return true;
        }
    }

    return false;
};

/**
 * `true` when `child`, sitting directly in `parent`, does not run on every
 * pass of the code around it. An `if`'s condition, a `while`'s test, a `for`'s
 * head, a `do` body, a `try` block and a `finally` block all run every time;
 * branches, loop bodies, `case` arms, `catch` clauses, the far side of a
 * logical operator, an optional call's arguments and nested functions do not.
 *
 * `alwaysRuns` names loops whose body a detector treats as running on every
 * pass anyway — a queue handler's `for (const m of batch.messages)`, whose body
 * runs once per message of every non-empty batch.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} child A node.
 * @param {AstNode} parent Its parent.
 * @param {(loop: AstNode) => boolean} alwaysRuns Loops not to count as guards.
 * @returns {boolean} Whether the parent guards the child.
 */
const conditionalPosition = (tree, child, parent, alwaysRuns) => {
    switch (parent.type) {
        case "AssignmentExpression": {
            return child !== parent.left && LOGICAL_ASSIGNMENTS.has(parent.operator);
        }
        case "BlockStatement":
        case "Program":
        case "StaticBlock": {
            // `if (done) return; site` — the site is a SIBLING of the guard, so
            // only an earlier statement of the same block that may leave shows it.
            return parent.body.some((statement) => statement.end <= child.start && mayLeave(tree, statement));
        }
        case "CallExpression": {
            return child !== parent.callee && inOptionalChain(parent);
        }
        case "CatchClause":
        case "PropertyDefinition":
        case "SwitchCase": {
            return true;
        }
        case "ConditionalExpression":
        case "IfStatement": {
            return child !== parent.test;
        }
        case "ForInStatement":
        case "WhileStatement": {
            return child === parent.body;
        }
        case "ForOfStatement": {
            return child === parent.body && !alwaysRuns(parent);
        }
        case "ForStatement": {
            return child === parent.body || child === parent.update;
        }
        case "LogicalExpression": {
            return child !== parent.left;
        }
        case "MemberExpression": {
            return child !== parent.object && inOptionalChain(parent);
        }
        default: {
            // A function nested in the handler runs only if, and as often as,
            // something calls it. The handler itself is where the walk stops.
            return isFunctionLike(parent);
        }
    }
};

/**
 * `true` when the call's effect can be undone or is observed: its result is
 * kept (`const id = await …`), or a `throw` follows it in the same function —
 * which makes the platform retry the invocation rather than accept its outcome.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} site The call.
 * @param {AstNode} owner The handler function.
 * @returns {boolean} Whether the call counts as guarded.
 */
const isRevocable = (tree, site, owner) => {
    let value = site;
    let parent = tree.parentOf(site);

    while (parent?.type === "AwaitExpression" || parent?.type === "ChainExpression") {
        value = parent;
        parent = tree.parentOf(parent);
    }

    const kept =
        (parent?.type === "VariableDeclarator" && parent.init === value) ||
        (parent?.type === "AssignmentExpression" && parent.operator === "=" && parent.right === value);

    return (
        kept ||
        descendants(tree, owner.body, (node) => node.type === "ThrowStatement").some(
            (statement) => statement.start >= site.end && firstAncestor(tree, statement, isFunctionLike) === owner,
        )
    );
};

/**
 * `true` when the call may not run on every invocation of `owner`: its own
 * optional chain, a revocable result ({@link isRevocable}), or any guarded
 * position ({@link conditionalPosition}) between it and the handler.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} site The call.
 * @param {AstNode} owner The handler function the walk stops at.
 * @param {(loop: AstNode) => boolean} [alwaysRuns] Loops whose body counts as unconditional (see {@link conditionalPosition}).
 * @returns {boolean} Whether the call is conditional.
 */
const isConditionalSite = (tree, site, owner, alwaysRuns = () => false) => {
    if (inOptionalChain(site) || isRevocable(tree, site, owner)) {
        return true;
    }

    let child = site;

    for (let parent = tree.parentOf(child); parent !== undefined && parent !== owner; parent = tree.parentOf(parent)) {
        if (conditionalPosition(tree, child, parent, alwaysRuns)) {
            return true;
        }

        child = parent;
    }

    return false;
};

export default isConditionalSite;
