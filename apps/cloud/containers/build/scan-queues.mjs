/**
 * The `queue_self_resend` detector: a `queue(batch, env)` handler that
 * unconditionally sends to a producer binding the release manifest maps to a
 * queue this same Worker consumes.
 */
import isConditionalSite from "./scan-guards.mjs";
import { descendants, FUNCTION_TYPES, keyName, memberName, positionOf } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */
/** @typedef {import("./scan-detect.mjs").RawFinding} RawFinding */

/**
 * The local names of a destructured `env` parameter: `{ SELF }` and
 * `{ SELF: queue }` both map a local to the binding it reads.
 * @param {AstNode} pattern An `ObjectPattern` parameter.
 * @returns {Map<string, string>} Local name → binding name.
 */
const destructuredBindings = (pattern) => {
    const bindings = new Map();

    for (const property of pattern.properties) {
        const binding = property.type === "Property" ? keyName(property.key, property.computed) : undefined;
        const local = property.value?.type === "AssignmentPattern" ? property.value.left : property.value;

        if (binding !== undefined && local?.type === "Identifier") {
            bindings.set(local.name, binding);
        }
    }

    return bindings;
};

/**
 * A `queue` handler: an object-literal method/function or a class method named
 * `queue`. Answers the function, its batch parameter's name, and how its `env`
 * is spelled: the second parameter's name, its destructured bindings, or
 * `this.env` on a class.
 * @param {AstNode} node An ESTree node.
 * @returns {{ batchName?: string, envBindings: Map<string, string>, envName?: string, fn: AstNode, viaThis: boolean } | undefined} The handler, or `undefined`.
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

    if (handlerFunction === undefined || !handlerFunction.body) {
        return undefined;
    }

    const [batch, environment] = handlerFunction.params;
    const envName = environment?.type === "Identifier" ? environment.name : undefined;
    const envBindings = environment?.type === "ObjectPattern" ? destructuredBindings(environment) : new Map();

    if (envName === undefined && envBindings.size === 0 && !viaThis) {
        return undefined;
    }

    return {
        ...(batch?.type === "Identifier" ? { batchName: batch.name } : {}),
        envBindings,
        ...(envName === undefined ? {} : { envName }),
        fn: handlerFunction,
        viaThis,
    };
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
 * @param {{ envBindings: Map<string, string>, envName?: string, viaThis: boolean }} handler How the handler spells `env`.
 * @returns {string | undefined} The producer binding sent to.
 */
const sentBinding = (node, handler) => {
    if (!isSendCall(node)) {
        return undefined;
    }

    const producer = node.callee.object;

    if (producer.type === "Identifier") {
        return handler.envBindings.get(producer.name);
    }

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
 * The `queue_self_resend` findings of one `queue()` handler.
 * @param {Tree} tree The parsed module's tree.
 * @param {NonNullable<ReturnType<typeof queueHandlerOf>>} handler The handler.
 * @param {Map<string, string>} selfFeeding Producer binding → the consumed queue it feeds.
 * @returns {RawFinding[]} One per unconditional send to its own queue.
 */
const queueFindings = (tree, handler, selfFeeding) => {
    // `for (const m of batch.messages)` runs its body for every message of every
    // batch, so a send inside it is as unconditional as one outside.
    const overBatch = (loop) =>
        handler.batchName !== undefined &&
        memberName(loop.right) === "messages" &&
        loop.right.object.type === "Identifier" &&
        loop.right.object.name === handler.batchName;

    return descendants(tree, handler.fn.body, (node) => selfFeeding.has(sentBinding(node, handler)))
        .filter((site) => !isConditionalSite(tree, site, handler.fn, overBatch))
        .map((site) => {
            const binding = sentBinding(site, handler);

            return { ...positionOf(site), binding, name: "queue_self_resend", queue: selfFeeding.get(binding) };
        });
};

export { isSendCall, queueFindings, queueHandlerOf, selfFeedingBindings };
