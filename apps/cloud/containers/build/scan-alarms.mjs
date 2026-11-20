/**
 * The `alarm_always_rearms` detector: a class's `alarm` handler that calls
 * `<storage>.setAlarm(…)` at a position that runs on every call.
 */
import isConditionalSite from "./scan-guards.mjs";
import { descendants, FUNCTION_TYPES, keyName, memberName, positionOf } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */
/** @typedef {import("./scan-detect.mjs").RawFinding} RawFinding */

/**
 * The storage a `<storage>.<method>(…)` call is made on: `<anything>.storage`,
 * or a bare `storage` (`const { storage } = this.ctx`).
 * @param {AstNode} node An ESTree node.
 * @param {string} method The storage method.
 * @returns {AstNode | undefined} The storage expression, when `node` is that call.
 */
const storageCallReceiver = (node, method) => {
    if (node.type !== "CallExpression" || memberName(node.callee) !== method) {
        return undefined;
    }

    const receiver = node.callee.object;

    return memberName(receiver) === "storage" || (receiver.type === "Identifier" && receiver.name === "storage") ? receiver : undefined;
};

/**
 * `<storage>.setAlarm(…)`.
 * @param {AstNode} node An ESTree node.
 * @returns {boolean} Whether it is that call.
 */
const isSetAlarmCall = (node) => storageCallReceiver(node, "setAlarm") !== undefined;

/**
 * A class's `alarm` handler — `alarm() {}` or an `alarm = async () => {}`
 * field — on any class, since a plain Worker's Durable Object extends
 * `DurableObject` from `cloudflare:workers` and a bundle has no other trace of
 * which classes are objects.
 * @param {AstNode} node An ESTree node.
 * @returns {AstNode | undefined} The handler's function, when `node` is one.
 */
const alarmHandlerOf = (node) => {
    const isMember = (node.type === "MethodDefinition" && node.kind === "method") || node.type === "PropertyDefinition";

    if (!isMember || node.static || keyName(node.key, node.computed) !== "alarm") {
        return undefined;
    }

    return node.value !== null && FUNCTION_TYPES.has(node.value.type) && node.value.body !== null ? node.value : undefined;
};

/** Below this re-arm delay an alarm is a tight loop rather than a periodic job. */
const TIGHT_REARM_MS = 60_000;

/**
 * The value of a constant numeric expression — `3600000`, `60 * 60 * 1000`, `36e5` — or `undefined`.
 * @param {AstNode} node An expression.
 * @returns {number | undefined} Its value, when it is statically a number.
 */
const constantNumber = (node) => {
    if (node.type === "Literal") {
        return typeof node.value === "number" ? node.value : undefined;
    }

    if (node.type !== "BinaryExpression" || !["*", "+", "-"].includes(node.operator)) {
        return undefined;
    }

    const left = constantNumber(node.left);
    const right = constantNumber(node.right);

    if (left === undefined || right === undefined) {
        return undefined;
    }

    if (node.operator === "*") {
        return left * right;
    }

    return node.operator === "+" ? left + right : left - right;
};

/**
 * @param {AstNode} node An expression.
 * @returns {boolean} Whether it is `Date.now()`.
 */
const isDateNow = (node) =>
    node.type === "CallExpression" && memberName(node.callee) === "now" && node.callee.object.type === "Identifier" && node.callee.object.name === "Date";

/**
 * How far ahead a `setAlarm(…)` call re-arms, when that is readable:
 * `Date.now()` (0), `Date.now() + N` with `N` constant, either wrapped in
 * `new Date(…)`. `undefined` for anything else — a delay held in a variable,
 * an absolute timestamp — which the detector treats as possibly immediate.
 * @param {AstNode} site The `setAlarm` call.
 * @returns {number | undefined} The delay in milliseconds.
 */
const rearmDelayOf = (site) => {
    let [time] = site.arguments;

    if (time?.type === "NewExpression" && time.callee.type === "Identifier" && time.callee.name === "Date" && time.arguments.length === 1) {
        [time] = time.arguments;
    }

    if (time === undefined) {
        return undefined;
    }

    if (isDateNow(time)) {
        return 0;
    }

    if (time.type !== "BinaryExpression" || time.operator !== "+") {
        return undefined;
    }

    if (isDateNow(time.left)) {
        return constantNumber(time.right);
    }

    return isDateNow(time.right) ? constantNumber(time.left) : undefined;
};

/**
 * The `alarm_always_rearms` findings of one `alarm` handler: every re-arm that
 * runs on every call and is not followed by a `deleteAlarm()` on the same
 * storage (re-arm, then cancel once done, is a way to stop). A readable delay
 * of a minute or more is a periodic job — reported as `INFO`; anything sooner,
 * or a delay the scan cannot read, is a tight loop — `WARN`.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} handler The handler's function.
 * @returns {RawFinding[]} One per unconditional re-arm.
 */
const alarmFindings = (tree, handler) => {
    const text = (node) => tree.source.slice(node.start, node.end);
    const deletes = descendants(tree, handler.body, (node) => storageCallReceiver(node, "deleteAlarm") !== undefined);

    return descendants(tree, handler.body, isSetAlarmCall)
        .filter((site) => !isConditionalSite(tree, site, handler))
        .filter((site) => {
            const storage = text(storageCallReceiver(site, "setAlarm"));

            return !deletes.some((call) => call.start >= site.end && text(storageCallReceiver(call, "deleteAlarm")) === storage);
        })
        .map((site) => {
            const delayMs = rearmDelayOf(site);
            const periodic = delayMs !== undefined && delayMs >= TIGHT_REARM_MS;

            return { ...positionOf(site), ...(delayMs === undefined ? {} : { delayMs }), level: periodic ? "INFO" : "WARN", name: "alarm_always_rearms" };
        });
};

export { alarmFindings, alarmHandlerOf, isSetAlarmCall };
