/**
 * The bundle scan's syntax tree: the one acorn parse of the module, its parent
 * index, and the walks and name helpers every analysis is built from.
 */
import { ScanError } from "./scan-budget.mjs";
import { Parser } from "./vendor/acorn.mjs";

/**
 * An ESTree node as acorn produces it (with `locations: true`).
 * @typedef {{ end: number, loc: { start: { column: number, line: number } }, start: number, type: string, [key: string]: unknown }} AstNode
 */

// --- the tree ---------------------------------------------------------------

/**
 * @param {unknown} value Anything.
 * @returns {boolean} Whether it is an ESTree node.
 */
const isNode = (value) => value !== null && typeof value === "object" && typeof value.type === "string";

/**
 * The child nodes of `node`, in source order.
 * @param {AstNode} node An ESTree node.
 * @returns {AstNode[]} Its direct children.
 */
const childrenOf = (node) => {
    const children = [];

    for (const key of Object.keys(node)) {
        if (key === "loc") {
            continue;
        }

        const value = node[key];

        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) {
                    children.push(item);
                }
            }
        } else if (isNode(value)) {
            children.push(value);
        }
    }

    return children;
};

/**
 * A boundary no `break`/`continue` crosses and past which a `return` leaves
 * something else: every function form, and a class `static { }` block.
 */
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression", "StaticBlock"]);

/**
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is a function boundary.
 */
const isFunctionLike = (node) => FUNCTION_TYPES.has(node.type);

/**
 * Parent links, the walk budget and the source text of one parsed module.
 * @typedef {{ check: () => void, parentOf: (node: AstNode) => AstNode | undefined, source: string }} Tree
 */

/**
 * Walk `root` depth-first, calling `visit` on every node (including `root`).
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} root Where to start.
 * @param {(node: AstNode) => void} visit Called once per node.
 * @returns {void}
 */
const walk = (tree, root, visit) => {
    const stack = [root];

    while (stack.length > 0) {
        const node = stack.pop();

        tree.check();
        visit(node);

        const children = childrenOf(node);

        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push(children[index]);
        }
    }
};

/**
 * Every node at or below `root` that matches.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} root Where to start.
 * @param {(node: AstNode) => boolean} predicate The filter.
 * @returns {AstNode[]} The matches, in source order.
 */
const descendants = (tree, root, predicate) => {
    const found = [];

    walk(tree, root, (node) => {
        if (predicate(node)) {
            found.push(node);
        }
    });

    return found;
};

/**
 * The nearest ancestor of `node` that matches, or `undefined`.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} node Where to start (not itself tested).
 * @param {(node: AstNode) => boolean} predicate The filter.
 * @returns {AstNode} The ancestor, or `undefined`.
 */
const firstAncestor = (tree, node, predicate) => {
    for (let parent = tree.parentOf(node); parent !== undefined; parent = tree.parentOf(parent)) {
        // Jump resolution walks ancestors once per jump per loop, so a crafted
        // nest of loops and jumps is quadratic here: the budget is checked too.
        tree.check();

        if (predicate(parent)) {
            return parent;
        }
    }

    return undefined;
};

/**
 * The name a property key spells: `alarm() {}` and `["alarm"]() {}` both name `alarm`.
 * @param {AstNode} key A property or method key.
 * @param {boolean} computed Whether the key is written in brackets.
 * @returns {string | undefined} The static name, if it has one.
 */
const keyName = (key, computed) => {
    if (!computed && key.type === "Identifier") {
        return key.name;
    }

    return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
};

/**
 * `<object>.<name>` — the static member name of a member expression.
 * @param {AstNode} node An ESTree node.
 * @returns {string | undefined} The member name, when `node` is a member access with a static one.
 */
const memberName = (node) => (node?.type === "MemberExpression" ? keyName(node.property, node.computed) : undefined);

/**
 * Where a finding is, in the bundle.
 * @param {AstNode} node The node it is reported at.
 * @returns {{ column: number, line: number }} Its start.
 */
const positionOf = (node) => {
    return { column: node.loc.start.column, line: node.loc.start.line };
};

/**
 * Parse a module and index its parents.
 * @param {string} code The module's source.
 * @param {() => void} check The deadline check, called during every walk.
 * @returns {{ comments: { line: number, text: string }[], program: AstNode, tree: Tree }} The parse.
 */
const parseModule = (code, check) => {
    const comments = [];
    let program;

    try {
        program = Parser.parse(code, {
            allowHashBang: true,
            ecmaVersion: "latest",
            locations: true,
            // esbuild marks each input's region with a `// <path>` line comment.
            // Called once per token: the parse is the one synchronous step that
            // cannot otherwise be interrupted, and its AST is where the memory goes.
            onToken: () => {
                check();
            },
            onComment: (block, text, _start, _end, startLoc) => {
                if (!block && startLoc.column === 0) {
                    comments.push({ line: startLoc.line, text: text.trim() });
                }
            },
            sourceType: "module",
        });
    } catch (error) {
        // The budget check, thrown from `onToken`: already the reason to give.
        if (error instanceof ScanError) {
            throw error;
        }

        // acorn's message is "<reason> (<line>:<column>)": no path, no source text.
        throw new ScanError(`the bundle could not be parsed (${error instanceof Error ? error.message : "unknown parse error"})`);
    }

    const parents = new WeakMap();
    const tree = { check, parentOf: (node) => parents.get(node), source: code };

    walk(tree, program, (node) => {
        for (const child of childrenOf(node)) {
            parents.set(child, node);
        }
    });

    return { comments, program, tree };
};

export { descendants, firstAncestor, FUNCTION_TYPES, isFunctionLike, keyName, memberName, parseModule, positionOf, walk };
