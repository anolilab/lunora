/**
 * The build-time scan of a built Worker bundle (warnings only, never a failure).
 *
 * It looks for code that, once started, can run without end and bill storage
 * operations on every pass: a Durable Object alarm that re-arms itself on every
 * run will wake its object forever, and a loop with no way out inside one turns
 * a single invocation into an unbounded stream of reads and writes. The scan
 * reads the one module `lunora build` produced, so it sees exactly what deploys.
 *
 * Three detectors, all over one acorn parse of that module.
 * `unbounded_loop`: `while (true)`, `for (;;)`, `for (; true;)` or
 * `do … while (true)` with no statically reachable exit (see {@link hasExit}).
 * `alarm_always_rearms`: a class method named `alarm` that calls
 * `<anything>.storage.setAlarm(…)` at a position that runs on every call.
 * `queue_self_resend`: a `queue(batch, env)` handler that unconditionally sends
 * to a producer binding the release manifest maps to a queue this same Worker
 * consumes.
 *
 * Conservative by construction: a guard is assumed wherever one might be, so a
 * report is something the code really does on every pass. The jump and guard
 * rules are a port of the codegen analyses (`discover/jumps.ts`,
 * `discover/unbounded-loops.ts`, `conditionalPosition` in
 * `discover/call-edges.ts`) from ts-morph to ESTree, and the tests carry their
 * case tables over so the two keep agreeing.
 *
 * Noise control: the bundle holds every dependency, and a finding in someone
 * else's code is not one the tenant can act on. Each candidate is mapped
 * through the bundle's sourcemap (wrangler writes `<module>.map` beside the
 * module in `--outdir` mode) and dropped when its original file is under
 * `node_modules`, in generated output (`.wrangler`, `.lunora`) or outside the
 * extracted repository. Without a sourcemap, esbuild's `// <path>` region
 * comments still say which input a statement came from; without either, the
 * finding is kept against the bundle itself and capped harder.
 *
 * Limits, because the build has a 9-minute budget and the bundle is tenant
 * output: a size cap before the (synchronous) parse, a cooperative deadline
 * checked inside every walk, and a cap on how many findings are reported.
 *
 * Zero dependencies beyond the vendored parser (`vendor/acorn.mjs`, a verbatim
 * copy of the catalog-pinned release), like the rest of the box.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

import { Parser } from "./vendor/acorn.mjs";

const MIB = 1024 * 1024;

/** Every cap the scan holds itself to. Injectable so tests can hit each one without a giant fixture. */
const DEFAULT_SCAN_LIMITS = Object.freeze({
    /**
     * Heap the scan needs per byte of bundle, sourcemap included: a real 4 MiB
     * wrangler bundle with its 7.5 MiB map peaked between 128 and 160 MiB of heap
     * (~32-40 bytes per byte), rounded up. A scan that would not fit is skipped,
     * never attempted: running the box out of heap would end the build's stream
     * with no release, which fails the build.
     */
    heapBytesPerBundleByte: 48,
    /** Findings attributed only to the bundle (no sourcemap, no region comment) — likelier to be noise, so fewer. */
    maxBundleFindings: 10,
    /** The parse is synchronous and cannot be interrupted, so its input is bounded instead. */
    maxBundleBytes: 32 * MIB,
    maxFindings: 50,
    maxMapBytes: 64 * MIB,
    timeoutMs: 10_000,
});

/**
 * A failure whose message is safe to show the tenant — it names the cause,
 * never a path inside the box. Also what a walk throws once the deadline passes.
 */
class ScanError extends Error {}

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

/** What an unlabeled `continue` binds to. */
const LOOP_TYPES = new Set(["DoWhileStatement", "ForInStatement", "ForOfStatement", "ForStatement", "WhileStatement"]);

const JUMP_TYPES = new Set(["BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement"]);

/**
 * Parent links and the walk budget for one parsed module.
 * @typedef {{ check: () => void, parentOf: (node: AstNode) => AstNode | undefined }} Tree
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

// --- jumps (port of codegen `discover/jumps.ts`) ----------------------------

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

// --- unbounded loops (port of codegen `discover/unbounded-loops.ts`) --------

/**
 * A loop condition that can never be false: absent (`for (;;)`), `true`, or
 * `!0` (what a minifier writes for `true`). acorn drops parentheses, so
 * `while ((true))` arrives as the bare literal.
 * @param {AstNode} test The loop's condition, or `null`.
 * @returns {boolean} Whether the loop is literally always on.
 */
const isAlwaysTrue = (test) =>
    test === null ||
    (test.type === "Literal" && test.value === true) ||
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

// --- guards (port of codegen `conditionalPosition` / `isConditionalSite`) ---

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
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} child A node.
 * @param {AstNode} parent Its parent.
 * @returns {boolean} Whether the parent guards the child.
 */
const conditionalPosition = (tree, child, parent) => {
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
        case "ForOfStatement":
        case "WhileStatement": {
            return child === parent.body;
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
 * @returns {boolean} Whether the call is conditional.
 */
const isConditionalSite = (tree, site, owner) => {
    if (inOptionalChain(site) || isRevocable(tree, site, owner)) {
        return true;
    }

    let child = site;

    for (let parent = tree.parentOf(child); parent !== undefined && parent !== owner; parent = tree.parentOf(parent)) {
        if (conditionalPosition(tree, child, parent)) {
            return true;
        }

        child = parent;
    }

    return false;
};

// --- the detectors ----------------------------------------------------------

/**
 * `<anything>.storage.setAlarm(…)`.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is that call.
 */
const isSetAlarmCall = (node) => node.type === "CallExpression" && memberName(node.callee) === "setAlarm" && memberName(node.callee.object) === "storage";

/**
 * A class's `alarm()` method body — any class, since a plain Worker's Durable
 * Object extends `DurableObject` from `cloudflare:workers` and a bundle has no
 * other trace of which classes are objects.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is an instance method named `alarm`.
 */
const isAlarmMethod = (node) =>
    node.type === "MethodDefinition" && node.kind === "method" && !node.static && keyName(node.key, node.computed) === "alarm" && node.value.body !== null;

/**
 * A `queue` handler: an object-literal method/function or a class method named
 * `queue`. Answers the function and how its `env` is spelled: the second
 * parameter's name, or `this.env` on a class.
 * @param {AstNode} node An ESTree node.
 * @returns {{ envName?: string, fn: AstNode, viaThis: boolean } | undefined} The handler, or `undefined`.
 */
const queueHandlerOf = (node) => {
    let handlerFunction;
    let viaThis = false;

    if (node.type === "Property" && keyName(node.key, node.computed) === "queue" && FUNCTION_TYPES.has(node.value.type)) {
        handlerFunction = node.value;
    } else if (node.type === "MethodDefinition" && node.kind === "method" && !node.static && keyName(node.key, node.computed) === "queue") {
        handlerFunction = node.value;
        viaThis = true;
    }

    if (handlerFunction === undefined || handlerFunction.body?.type !== "BlockStatement") {
        return undefined;
    }

    const environment = handlerFunction.params[1];
    const envName = environment?.type === "Identifier" ? environment.name : undefined;

    return envName === undefined && !viaThis ? undefined : { ...(envName === undefined ? {} : { envName }), fn: handlerFunction, viaThis };
};

/**
 * `<anything>.send(…)` / `<anything>.sendBatch(…)`.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is a queue-producer-shaped call.
 */
const isSendCall = (node) => node.type === "CallExpression" && (memberName(node.callee) === "send" || memberName(node.callee) === "sendBatch");

/**
 * `env.<B>.send(…)` / `env.<B>.sendBatch(…)` (or `this.env.<B>…` on a class) → `B`.
 * @param {AstNode} node An ESTree node.
 * @param {{ envName?: string, viaThis: boolean }} handler How the handler spells `env`.
 * @returns {string | undefined} The producer binding sent to.
 */
const sentBinding = (node, handler) => {
    if (!isSendCall(node)) {
        return undefined;
    }

    const producer = node.callee.object;
    const binding = memberName(producer);
    const base = producer?.object;
    const isEnvironment =
        (handler.envName !== undefined && base?.type === "Identifier" && base.name === handler.envName) ||
        (handler.viaThis && base?.type === "MemberExpression" && base.object.type === "ThisExpression" && memberName(base) === "env");

    return binding !== undefined && isEnvironment ? binding : undefined;
};

/**
 * Producer bindings whose queue this Worker also consumes, from the release
 * manifest (`queue_producer` / `queue_consumer` entries, `resource` = queue name).
 * @param {unknown} manifest The release's binding manifest.
 * @returns {Map<string, string>} Binding → the queue it feeds back into.
 */
const selfFeedingBindings = (manifest) => {
    const bindings = Array.isArray(manifest?.bindings) ? manifest.bindings : [];
    const consumed = new Set(bindings.filter((entry) => entry?.type === "queue_consumer" && typeof entry.resource === "string").map((entry) => entry.resource));

    return new Map(
        bindings
            .filter((entry) => entry?.type === "queue_producer" && typeof entry.binding === "string" && consumed.has(entry.resource))
            .map((entry) => [entry.binding, entry.resource]),
    );
};

/**
 * One raw finding, before attribution: where in the bundle, and what.
 * @typedef {{ column: number, line: number, loopKind?: string, name: string, binding?: string, queue?: string }} RawFinding
 */

/**
 * @param {AstNode} loop A literal-infinite loop.
 * @returns {string} How it is written, for the message.
 */
const loopKindOf = (loop) => {
    if (loop.type === "DoWhileStatement") {
        return "do … while (true)";
    }

    return loop.type === "WhileStatement" ? "while (true)" : "for (;;)";
};

/**
 * Where a finding is, in the bundle.
 * @param {AstNode} node The node it is reported at.
 * @returns {{ column: number, line: number }} Its start.
 */
const positionOf = (node) => {
    return { column: node.loc.start.column, line: node.loc.start.line };
};

/**
 * The candidates of each detector, collected in one walk.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} program The module.
 * @returns {{ alarms: AstNode[], loops: AstNode[], queues: NonNullable<ReturnType<typeof queueHandlerOf>>[] }} The candidates.
 */
const candidatesOf = (tree, program) => {
    const loops = [];
    const alarms = [];
    const queues = [];

    walk(tree, program, (node) => {
        const handler = queueHandlerOf(node);

        if (isAlwaysOnLoop(node)) {
            loops.push(node);
        } else if (isAlarmMethod(node)) {
            alarms.push(node);
        } else if (handler !== undefined) {
            queues.push(handler);
        }
    });

    return { alarms, loops, queues };
};

/**
 * The `alarm_always_rearms` findings of one `alarm()` method.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} method The method definition.
 * @returns {RawFinding[]} One per unconditional re-arm.
 */
const alarmFindings = (tree, method) =>
    descendants(tree, method.value.body, isSetAlarmCall)
        .filter((site) => !isConditionalSite(tree, site, method.value))
        .map((site) => {
            return { ...positionOf(site), name: "alarm_always_rearms" };
        });

/**
 * The `queue_self_resend` findings of one `queue()` handler.
 * @param {Tree} tree The parsed module's tree.
 * @param {NonNullable<ReturnType<typeof queueHandlerOf>>} handler The handler.
 * @param {Map<string, string>} selfFeeding Producer binding → the consumed queue it feeds.
 * @returns {RawFinding[]} One per unconditional send to its own queue.
 */
const queueFindings = (tree, handler, selfFeeding) =>
    descendants(tree, handler.fn.body, (node) => selfFeeding.has(sentBinding(node, handler)))
        .filter((site) => !isConditionalSite(tree, site, handler.fn))
        .map((site) => {
            const binding = sentBinding(site, handler);

            return { ...positionOf(site), binding, name: "queue_self_resend", queue: selfFeeding.get(binding) };
        });

/**
 * Find every raw finding in a parsed module.
 *
 * Two passes: one walk collects the candidates (cheap), `keep` drops those the
 * tenant cannot act on (dependency code), and only the survivors get the
 * per-candidate analyses — so third-party loops never spend the time budget.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} program The module.
 * @param {{ keep: (position: { column: number, line: number }) => boolean, manifest?: unknown }} options Attribution filter and the release manifest.
 * @returns {RawFinding[]} The findings.
 */
const detect = (tree, program, { keep, manifest }) => {
    const { alarms, loops, queues } = candidatesOf(tree, program);
    const kept = (node) => keep(node.loc.start);
    const selfFeeding = selfFeedingBindings(manifest);

    return [
        ...loops
            .filter((loop) => kept(loop) && !hasExit(tree, loop) && !yieldsFromLoop(tree, loop))
            .map((loop) => {
                return { ...positionOf(loop), loopKind: loopKindOf(loop), name: "unbounded_loop" };
            }),
        ...alarms.filter((method) => kept(method)).flatMap((method) => alarmFindings(tree, method)),
        ...(selfFeeding.size === 0 ? [] : queues.filter((handler) => kept(handler.fn)).flatMap((handler) => queueFindings(tree, handler, selfFeeding))),
    ];
};

/**
 * A deadline check for the walks: throws once `deadline` has passed. The clock
 * is read every 1024 calls — cheap, and still far finer than the budget.
 * @param {() => number} now The clock.
 * @param {number} deadline Epoch milliseconds.
 * @param {string} message What the failure says.
 * @returns {() => void} The check; also throws immediately when already late.
 */
const deadlineCheck = (now, deadline, message) => {
    let calls = 0;

    if (now() > deadline) {
        throw new ScanError(message);
    }

    return () => {
        calls += 1;

        if (calls % 1024 === 0 && now() > deadline) {
            throw new ScanError(message);
        }
    };
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
            onComment: (block, text, _start, _end, startLoc) => {
                if (!block && startLoc.column === 0) {
                    comments.push({ line: startLoc.line, text: text.trim() });
                }
            },
            sourceType: "module",
        });
    } catch (error) {
        // acorn's message is "<reason> (<line>:<column>)": no path, no source text.
        throw new ScanError(`the bundle could not be parsed (${error instanceof Error ? error.message : "unknown parse error"})`);
    }

    const parents = new WeakMap();
    const tree = { check, parentOf: (node) => parents.get(node) };

    walk(tree, program, (node) => {
        for (const child of childrenOf(node)) {
            parents.set(child, node);
        }
    });

    return { comments, program, tree };
};

/**
 * The raw findings in one module's source — the analysis without any
 * attribution, for the tests and for {@link scanBundle}.
 * @param {string} code A JavaScript module.
 * @param {{ deadline?: number, keep?: (position: { column: number, line: number }) => boolean, manifest?: unknown, now?: () => number }} [options] Deadline (epoch ms), attribution filter, release manifest, clock.
 * @returns {RawFinding[]} The findings, in source order.
 */
const analyzeSource = (code, options = {}) => {
    const check = deadlineCheck(options.now ?? Date.now, options.deadline ?? Number.POSITIVE_INFINITY, "the scan ran past its time budget");
    const { program, tree } = parseModule(code, check);

    return detect(tree, program, { keep: options.keep ?? (() => true), manifest: options.manifest }).toSorted((a, b) => a.line - b.line || a.column - b.column);
};

// --- attribution -----------------------------------------------------------

// eslint-disable-next-line no-secrets/no-secrets -- the base64 alphabet, not a credential
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((character, index) => [character, index]));

/**
 * The fields of one sourcemap segment: base64 VLQ, five bits per digit with a
 * continuation bit, least significant group first, sign in the lowest bit.
 * @param {string} segment One comma-separated segment of `mappings`.
 * @returns {number[]} Its (delta) fields.
 */
const segmentFields = (segment) => {
    const fields = [];
    let value = 0;
    let scale = 1;

    for (const character of segment) {
        const digit = BASE64_VALUE.get(character);

        if (digit === undefined) {
            throw new ScanError("the bundle's sourcemap has malformed mappings");
        }

        // Arithmetic rather than bit operators: the same VLQ, without 32-bit overflow on a long digit run.
        value += (digit % 32) * scale;

        if (digit < 32) {
            fields.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
            value = 0;
            scale = 1;
        } else {
            scale *= 32;
        }
    }

    return fields;
};

/**
 * Decode the segments of a v3 sourcemap's `mappings` for the generated lines
 * asked for. Source and original-line fields are deltas across the whole
 * string, so every segment is decoded; only the wanted lines are kept.
 * @param {string} mappings The `mappings` string.
 * @param {Set<number>} wanted Generated lines (1-based) to keep.
 * @param {() => void} check The deadline check.
 * @returns {Map<number, number[][]>} Line → its `[generatedColumn, source, originalLine]` segments, in column order.
 */
const decodeMappings = (mappings, wanted, check) => {
    const lines = new Map();
    let source = 0;
    let originalLine = 0;

    for (const [index, text] of mappings.split(";").entries()) {
        const line = index + 1;
        const keep = wanted.has(line);
        const kept = [];
        let generatedColumn = 0;

        check();

        for (const segment of text === "" ? [] : text.split(",")) {
            const fields = segmentFields(segment);

            generatedColumn += fields[0] ?? 0;

            if (fields.length >= 4) {
                source += fields[1];
                originalLine += fields[2];

                if (keep) {
                    kept.push([generatedColumn, source, originalLine]);
                }
            }
        }

        if (kept.length > 0) {
            lines.set(line, kept);
        }
    }

    return lines;
};

/**
 * Where a finding's code came from, relative to the repository — or why it is
 * none of the tenant's business.
 * @typedef {{ file: string, line: number, location: "bundle" | "source" } | { dropped: true }} Attribution
 */

/** Path segments whose files the tenant did not write: dependencies and generated output. */
const FOREIGN_SEGMENTS = new Set([".lunora", ".wrangler", "node_modules"]);

/**
 * A repo-relative POSIX path for `absolute`, or `undefined` when it lies
 * outside the repository or in code the tenant did not write.
 * @param {string} repo Real path of the extracted repo.
 * @param {string} absolute An absolute path.
 * @returns {string | undefined} The path to report.
 */
const tenantPath = (repo, absolute) => {
    const path = relative(repo, absolute);

    if (path === "" || path.startsWith("..") || isAbsolute(path)) {
        return undefined;
    }

    const segments = path.split(sep);

    return segments.some((segment) => FOREIGN_SEGMENTS.has(segment)) ? undefined : segments.join("/");
};

/** A `scheme:` prefix — a URL, which names nothing on this disk. */
const URL_SCHEME = /^[a-z][\w+.-]*:/iu;

/** The trailing `sourceMappingURL` comment of a module. */
const SOURCE_MAPPING_URL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/u;

/**
 * A sourcemap `sources` entry as an absolute path. Resolved against the map's
 * own directory, ignoring `sourceRoot`: wrangler writes `sourceRoot: "out"`
 * beside sources already relative to the map, and honouring both points every
 * path one directory too deep. Only plain paths and `file:` URLs resolve.
 * @param {string} mapDirectory Directory holding the map.
 * @param {unknown} source The `sources` entry.
 * @returns {string | undefined} The path, or `undefined` for anything else.
 */
const sourcePath = (mapDirectory, source) => {
    if (typeof source !== "string" || source === "") {
        return undefined;
    }

    if (source.startsWith("file://")) {
        try {
            return fileURLToPath(source);
        } catch {
            return undefined;
        }
    }

    return URL_SCHEME.test(source) ? undefined : resolve(mapDirectory, source);
};

/**
 * The bundle's sourcemap: `<module>.map` beside it, else the file a relative
 * `sourceMappingURL` names — only when it resolves inside the module's own
 * directory, because the module is tenant output and must not steer this read
 * anywhere else. Size-capped before it is read.
 *
 * Containment is checked on real paths, but `sources` resolve against the
 * directory as the bundler was given it: esbuild writes them relative to that
 * spelling, so through a symlinked out-dir the real path is the wrong base.
 * @param {string} bundlePath Path of the module.
 * @param {string} code The module's source.
 * @param {typeof DEFAULT_SCAN_LIMITS} limits The caps.
 * @returns {Promise<{ directory: string, map: { mappings: string, sources: unknown[] } } | undefined>} The parsed map and the directory its sources resolve against, or `undefined`.
 */
const readSourcemap = async (bundlePath, code, limits) => {
    const directory = await realpath(dirname(bundlePath));
    const named = SOURCE_MAPPING_URL.exec(code.slice(-4096))?.[1];
    const candidates = [`${bundlePath}.map`, ...(named !== undefined && !named.includes(":") ? [join(directory, decodeURIComponent(named))] : [])];

    for (const candidate of candidates) {
        let path;

        try {
            // eslint-disable-next-line no-await-in-loop -- at most two candidates, first one wins
            path = await realpath(candidate);
        } catch {
            continue;
        }

        if (dirname(path) !== directory) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- see above
        const { size } = await stat(path);

        if (size > limits.maxMapBytes) {
            throw new ScanError(`the bundle's sourcemap is ${(size / MIB).toFixed(1)} MiB, over the ${String(limits.maxMapBytes / MIB)} MiB the scan reads`);
        }

        let map;

        try {
            // eslint-disable-next-line no-await-in-loop -- see above
            map = JSON.parse(await readFile(path, "utf8"));
        } catch {
            throw new ScanError("the bundle's sourcemap is not JSON");
        }

        // Index maps (`sections`) are not produced by esbuild; they fall back like no map.
        return map?.version === 3 && Array.isArray(map.sources) && typeof map.mappings === "string" ? { directory: dirname(bundlePath), map } : undefined;
    }

    return undefined;
};

/**
 * Attribute positions through a sourcemap.
 * @param {{ directory: string, map: { mappings: string, sources: unknown[] } }} sourcemap The parsed map.
 * @param {string} repo Real path of the extracted repo.
 * @param {Set<number>} lines Generated lines that need answers.
 * @param {() => void} check The deadline check.
 * @returns {(position: { column: number, line: number }) => Attribution} The attributor.
 */
const sourcemapAttributor = (sourcemap, repo, lines, check) => {
    const segments = decodeMappings(sourcemap.map.mappings, lines, check);

    return ({ column, line }) => {
        const onLine = segments.get(line);

        if (onLine === undefined) {
            return { dropped: true };
        }

        // The segment covering the column; a statement esbuild indented starts
        // before its line's first mapping, which then answers for it.
        const segment = onLine.findLast(([generatedColumn]) => generatedColumn <= column) ?? onLine[0];
        const absolute = sourcePath(sourcemap.directory, sourcemap.map.sources[segment[1]]);
        const file = absolute === undefined ? undefined : tenantPath(repo, absolute);

        return file === undefined ? { dropped: true } : { file, line: segment[2] + 1, location: "source" };
    };
};

/** An esbuild region comment's path: no spaces, ends in a script extension. */
const REGION_PATH = /^[\w@.~+/-]+\.[cm]?[jt]sx?$/u;

/**
 * Attribute positions by esbuild's `// <path>` region comments when there is no
 * sourcemap: the nearest region comment above a line names its input, relative
 * to the directory `lunora build` ran in. The line reported is the bundle's.
 * @param {{ line: number, text: string }[]} comments Column-0 line comments, in order.
 * @param {string} project Real path of the project directory.
 * @param {string} repo Real path of the extracted repo.
 * @param {string} bundleFile The bundle's repo-relative path, for findings no region names.
 * @returns {(position: { column: number, line: number }) => Attribution} The attributor.
 */
const regionAttributor = (comments, project, repo, bundleFile) => {
    const regions = comments.filter((comment) => REGION_PATH.test(comment.text));

    return ({ line }) => {
        const region = regions.findLast((comment) => comment.line < line);

        if (region === undefined) {
            return { file: bundleFile, line, location: "bundle" };
        }

        const file = tenantPath(repo, resolve(project, region.text));

        return file === undefined ? { dropped: true } : { file, line, location: "bundle" };
    };
};

// --- reporting -------------------------------------------------------------

/**
 * The tenant-facing advisory for one attributed finding.
 * @param {RawFinding} finding The raw finding.
 * @param {{ file: string, line: number, location: "bundle" | "source" }} where Its attribution.
 * @returns {{ cacheKey: string, detail: string, file: string, level: "WARN", line: number, location: "bundle" | "source", name: string, remediation: string, title: string }} The advisory.
 */
const advisoryOf = (finding, where) => {
    const place = where.location === "source" ? `${where.file}:${String(where.line)}` : `line ${String(where.line)} of the built bundle (${where.file})`;
    const base = {
        cacheKey: `${finding.name}:${where.file}:${String(where.line)}`,
        file: where.file,
        level: "WARN",
        line: where.line,
        location: where.location,
        name: finding.name,
    };

    if (finding.name === "unbounded_loop") {
        return {
            ...base,
            detail: `\`${finding.loopKind ?? "while (true)"}\` at ${place} has no break, return or throw that can leave it, so once it starts it runs until the platform kills the invocation — billing every storage read and write inside it on each pass.`,
            remediation:
                "Give the loop an exit: a counter or deadline that breaks or returns, or `signal.throwIfAborted()`. An `await` inside the loop is not an exit — it only yields, and the loop resumes.",
            title: "Loop with no exit",
        };
    }

    if (finding.name === "alarm_always_rearms") {
        return {
            ...base,
            detail: `\`alarm()\` calls \`storage.setAlarm(…)\` at ${place} on every run, with nothing that can skip it, so the Durable Object wakes itself forever — billing an invocation and its storage operations each time.`,
            remediation:
                "Re-arm only while work remains: put `setAlarm` behind a condition, return before it once the work is done, or call `storage.deleteAlarm()` when finished.",
            title: "Alarm always re-arms itself",
        };
    }

    return {
        ...base,
        detail: `\`queue()\` sends to \`${finding.binding ?? "?"}\` at ${place} on every batch, and that binding produces to \`${finding.queue ?? "?"}\` — the queue this Worker consumes — so every message begets another, forever.`,
        remediation:
            "Re-enqueue only when a message needs another pass (a condition or an attempt counter in the body), use `message.retry()` with a retry limit and a dead-letter queue, or send to a different queue.",
        title: "Queue consumer re-sends to its own queue",
    };
};

/**
 * @returns {number} Bytes the heap can still grow by before this process runs out.
 */
const heapAvailable = () => {
    const { heap_size_limit: limit, used_heap_size: used } = getHeapStatistics();

    return limit - used;
};

/**
 * Scan one built Worker module. Throws a {@link ScanError} (message safe to
 * show) when it cannot: an oversized or unparsable bundle, a malformed
 * sourcemap, or the deadline — the caller logs that as a skipped scan.
 * @param {{ bundle: Buffer, bundlePath: string, heapAvailable?: () => number, limits?: Partial<typeof DEFAULT_SCAN_LIMITS>, manifest?: unknown, now?: () => number, project: string, repo: string }} input The module's bytes and path, the release manifest, the project and repo directories (real paths), and — for tests — the free heap and the clock.
 * @returns {Promise<{ advisories: ReturnType<typeof advisoryOf>[], omitted: number }>} What to report, and how many findings the caps held back.
 */
const scanBundle = async (input) => {
    const limits = { ...DEFAULT_SCAN_LIMITS, ...input.limits };
    const now = input.now ?? Date.now;
    const deadline = now() + limits.timeoutMs;

    if (input.bundle.length > limits.maxBundleBytes) {
        throw new ScanError(`the bundle is ${(input.bundle.length / MIB).toFixed(1)} MiB, over the ${String(limits.maxBundleBytes / MIB)} MiB the scan reads`);
    }

    const needed = input.bundle.length * limits.heapBytesPerBundleByte;
    const available = (input.heapAvailable ?? heapAvailable)();

    if (needed > available) {
        throw new ScanError(
            `scanning a ${(input.bundle.length / MIB).toFixed(1)} MiB bundle needs about ${String(Math.ceil(needed / MIB))} MiB of memory and ${String(Math.floor(available / MIB))} MiB is free`,
        );
    }

    const code = input.bundle.toString("utf8");
    const sourcemap = await readSourcemap(input.bundlePath, code, limits);
    const late = `the scan ran past ${String(limits.timeoutMs / 1000)} s`;
    const { comments, program, tree } = parseModule(code, deadlineCheck(now, deadline, late));
    // The parse itself cannot be interrupted; a slow one is caught here.
    const check = deadlineCheck(now, deadline, late);

    // Candidate lines first, so the sourcemap pass keeps only what it needs.
    const lines = new Set();

    walk(tree, program, (node) => {
        const handler = queueHandlerOf(node);

        if (isAlwaysOnLoop(node) || isAlarmMethod(node) || isSetAlarmCall(node) || isSendCall(node)) {
            lines.add(node.loc.start.line);
        } else if (handler !== undefined) {
            lines.add(handler.fn.loc.start.line);
        }
    });

    const bundleFile = relative(input.repo, input.bundlePath).split(sep).join("/");
    const attribute =
        sourcemap === undefined ? regionAttributor(comments, input.project, input.repo, bundleFile) : sourcemapAttributor(sourcemap, input.repo, lines, check);
    const attributions = new Map();
    const attributionOf = (position) => {
        const key = `${String(position.line)}:${String(position.column)}`;

        if (!attributions.has(key)) {
            attributions.set(key, attribute(position));
        }

        return attributions.get(key);
    };

    const raw = detect(tree, program, { keep: (position) => !("dropped" in attributionOf(position)), manifest: input.manifest });
    const advisories = [];
    const seen = new Map();

    for (const finding of raw) {
        const where = attributionOf(finding);

        if ("dropped" in where) {
            continue;
        }

        const advisory = advisoryOf(finding, where);
        const occurrence = (seen.get(advisory.cacheKey) ?? 0) + 1;

        seen.set(advisory.cacheKey, occurrence);
        advisories.push(occurrence === 1 ? advisory : { ...advisory, cacheKey: `${advisory.cacheKey}:${String(occurrence)}` });
    }

    advisories.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

    const fromSource = advisories.filter((advisory) => advisory.location === "source");
    const fromBundle = advisories.filter((advisory) => advisory.location === "bundle").slice(0, limits.maxBundleFindings);
    const reported = [...fromSource, ...fromBundle].slice(0, limits.maxFindings);

    return { advisories: reported, omitted: advisories.length - reported.length };
};

/**
 * The tenant-facing reason a scan was skipped. A {@link ScanError} names its
 * cause; anything else is the box's own bug, logged for the operator and
 * generalised — like `clientError` in `server.mjs`, nothing internal travels.
 * @param {unknown} error Whatever the scan threw.
 * @returns {string} The reason.
 */
const scanFailure = (error) => {
    if (error instanceof ScanError) {
        return error.message;
    }

    process.stderr.write(`internal build-scan failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);

    return "the scanner failed unexpectedly; the platform operator has the details";
};

export { analyzeSource, decodeMappings, DEFAULT_SCAN_LIMITS, scanBundle, scanFailure };
