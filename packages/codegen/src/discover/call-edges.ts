import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import type { CallEdgeIR } from "../ir";
import { collectCallRows, collectNodeRows, functionKeyOf, isFunctionLike, isSameNode, RUN_METHODS } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { mayLeave } from "./jumps";

/** `ctx.<surface>.<name>.<method>(…)` → `name`, when the receiver chain is exactly that shape. */
const surfaceMemberOf = (callee: TsNode, surface: string): string | undefined => {
    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const member = callee.getExpression();

    if (!Node.isPropertyAccessExpression(member)) {
        return undefined;
    }

    const owner = member.getExpression();

    return Node.isPropertyAccessExpression(owner) && owner.getName() === surface ? member.getName() : undefined;
};

/** True when a `runAfter`/`runAt` call's receiver is `<…>.scheduler`. */
const isSchedulerCall = (callee: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(callee)) {
        return false;
    }

    const receiver = callee.getExpression();

    return (
        (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "scheduler") || (Node.isIdentifier(receiver) && receiver.getText() === "scheduler")
    );
};

/** Producer methods that hand work to a declared surface: `ctx.<surface>.<name>.<method>(…)`. */
const SURFACE_METHODS: ReadonlyMap<string, { kind: "enqueue" | "publish"; surface: string }> = new Map([
    ["publish", { kind: "publish", surface: "topics" }],
    ["publishBatch", { kind: "publish", surface: "topics" }],
    ["send", { kind: "enqueue", surface: "queues" }],
    ["sendBatch", { kind: "enqueue", surface: "queues" }],
]);

/** A `namespace:export` dispatch key, as a string target spells it. */
const FUNCTION_KEY = /^[\w$]+:[\w$]+$/u;

type CallSiteEdge = Omit<CallEdgeIR, "file" | "line" | "scope">;

/** A `run*` call: drawn when its reference is static, reported when an explicit `runQuery`/… target is not. */
const runEdge = (method: string, reference: TsNode | undefined): CallSiteEdge | undefined => {
    const target = functionKeyOf(reference);

    if (target !== undefined) {
        return { kind: "call", target };
    }

    // A bare `.run(x)` is too common a name to claim; the explicit
    // `runQuery`/`runMutation`/`runAction` with an unreadable target is a real
    // edge the graph cannot draw, so it is reported rather than dropped.
    return method !== "run" && reference !== undefined
        ? { kind: "call", reason: 'the function reference is not a static api.* / internal.* chain or a "namespace:export" key' }
        : undefined;
};

/** The edge one call expression contributes, or `undefined` when it is not an edge-shaped call. */
const edgeOf = (call: CallExpression): CallSiteEdge | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const method = callee.getName();
    const [first, second] = call.getArguments();

    if (RUN_METHODS.has(method)) {
        return runEdge(method, first);
    }

    if ((method === "runAfter" || method === "runAt") && isSchedulerCall(callee)) {
        // The scheduler also takes the dispatch key itself: `runAfter(0, "payments:charge", …)`.
        const target =
            functionKeyOf(second) ?? (Node.isStringLiteral(second) && FUNCTION_KEY.test(second.getLiteralText()) ? second.getLiteralText() : undefined);

        return target === undefined
            ? { kind: "schedule", reason: 'the scheduled function is not a static api.* / internal.* chain or a "namespace:export" key' }
            : { kind: "schedule", target };
    }

    const producer = SURFACE_METHODS.get(method);
    const target = producer === undefined ? undefined : surfaceMemberOf(callee, producer.surface);

    return producer === undefined || target === undefined ? undefined : { kind: producer.kind, target };
};

/** Logical operators, whose right operand is evaluated only when the left one allows it. */
const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set<SyntaxKind>([
    SyntaxKind.AmpersandAmpersandEqualsToken,
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarEqualsToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionEqualsToken,
    SyntaxKind.QuestionQuestionToken,
]);

/** `true` when TypeScript marks `node` as a link of an optional chain — evaluated only when no earlier `?.` short-circuited. */
const inOptionalChain = (node: TsNode): boolean => ts.isOptionalChain(node.compilerNode);

/**
 * `true` when `child`, sitting directly in `parent`, does not run on every pass
 * of the code around it. Exact rather than kind-based, so a guard is only
 * claimed where one is: an `if`'s condition, a `while`'s test, a `for`'s head,
 * a `do` body, a `try` block and a `switch` discriminant all run every time;
 * the branches, loop bodies, `case` arms and `catch` clauses do not.
 */
const conditionalPosition = (child: TsNode, parent: TsNode): boolean => {
    if (Node.isIfStatement(parent)) {
        return !isSameNode(child, parent.getExpression());
    }

    if (Node.isWhileStatement(parent) || Node.isForInStatement(parent) || Node.isForOfStatement(parent)) {
        return isSameNode(child, parent.getStatement());
    }

    if (Node.isForStatement(parent)) {
        return isSameNode(child, parent.getStatement()) || isSameNode(parent.getIncrementor(), child);
    }

    if (Node.isCaseClause(parent) || Node.isDefaultClause(parent) || Node.isCatchClause(parent)) {
        return true;
    }

    // A function nested in another — `items.forEach(() => …)`, a `.then(…)`, a
    // local closure — runs only if, and as often as, something calls it. The
    // outermost function (the handler, a top-level helper) is the one that runs.
    if (isFunctionLike(parent)) {
        return parent.getFirstAncestor(isFunctionLike) !== undefined;
    }

    if (Node.isConditionalExpression(parent)) {
        return !isSameNode(child, parent.getCondition());
    }

    if (Node.isBinaryExpression(parent)) {
        return !isSameNode(child, parent.getLeft()) && LOGICAL_OPERATORS.has(parent.getOperatorToken().getKind());
    }

    // `a?.b(site)` / `a?.[site]` — skipped whole when the chain short-circuits.
    if ((Node.isCallExpression(parent) || Node.isElementAccessExpression(parent)) && inOptionalChain(parent)) {
        return !isSameNode(child, parent.getExpression());
    }

    // `if (done) return; site` — the site is a SIBLING of the guard, not beneath
    // it, so only an earlier statement of the same block that may leave it shows it.
    return Node.isBlock(parent) && parent.getStatements().some((statement) => statement.getEnd() <= child.getStart() && mayLeave(statement));
};

/**
 * `true` when a scheduled dispatch can be undone: its returned id is kept
 * (`const id = await ctx.scheduler.runAfter(…)`), so something can `cancel` it,
 * or a `throw` follows it in the same function, which rolls the mutation — and
 * the schedule with it — back.
 */
const isRevocableSchedule = (site: TsNode): boolean => {
    let value: TsNode = site;
    let parent = site.getParent();

    while (parent !== undefined && (Node.isAwaitExpression(parent) || Node.isParenthesizedExpression(parent))) {
        value = parent;
        parent = parent.getParent();
    }

    const kept =
        Node.isVariableDeclaration(parent) ||
        (Node.isBinaryExpression(parent) && isSameNode(value, parent.getRight()) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken);
    const owner = site.getFirstAncestor(isFunctionLike);

    return (
        kept ||
        owner
            ?.getDescendantsOfKind(SyntaxKind.ThrowStatement)
            .some((statement) => statement.getStart() >= site.getEnd() && isSameNode(statement.getFirstAncestor(isFunctionLike), owner)) === true
    );
};

/**
 * `true` when the edge may not take effect on every pass of its function: any
 * position {@link conditionalPosition} calls guarded between the site and the
 * file, the site's own optional chain (`ctx.scheduler?.runAfter(…)`), or — for
 * a schedule — a dispatch that can be undone ({@link isRevocableSchedule}).
 * Walked to the `SourceFile` rather than the nearest function, so a guard ABOVE
 * the callback holding the site (`if (enabled) { const work = () => … }`) is
 * seen as well as one inside it.
 */
const isConditionalSite = (site: TsNode, kind: CallEdgeIR["kind"]): boolean => {
    if (inOptionalChain(site) || (kind === "schedule" && isRevocableSchedule(site))) {
        return true;
    }

    let child: TsNode = site;

    for (let parent = child.getParent(); parent !== undefined && !Node.isSourceFile(parent); parent = parent.getParent()) {
        if (conditionalPosition(child, parent)) {
            return true;
        }

        child = parent;
    }

    return false;
};

/** The {@link CallEdgeIR} of a site, or `undefined` when it carries no edge. */
const edgeRecord = (site: TsNode, file: string, edge: CallSiteEdge | undefined): CallEdgeIR | undefined =>
    edge === undefined
        ? undefined
        : {
              ...edge,
              ...(isConditionalSite(site, edge.kind) ? { conditional: true as const } : {}),
              file,
              line: site.getStartLineNumber(),
              scope: callSiteScopeOf(site),
          };

/**
 * Discover the call-site edges of the architecture graph: every function →
 * function call (`ctx.run*`), scheduled dispatch (`ctx.scheduler.runAfter/runAt`),
 * enqueue (`ctx.queues.<q>.send`), topic publish (`ctx.topics.<t>.publish`) and
 * service use (`ctx.services.<s>.<member>`; a destructured `ctx.services` is not seen) in
 * `lunora/`, one record per site with its `CallSiteScope`. A target is read off
 * the reference's syntax, not resolved through the type checker (the scope's
 * helper attribution does use it), so a reference held in a variable is recorded
 * with a `reason` instead of a `target`; the manifest builder reports it, and a
 * site no export reaches, rather than guessing.
 */
const discoverCallEdges = (project: Project, lunoraDirectory: string): CallEdgeIR[] => [
    ...collectCallRows(project, lunoraDirectory, (call, file) => edgeRecord(call, file, edgeOf(call))),
    // `ctx.services.<name>.<member>`, called or not: an RPC method has an
    // arbitrary name, and a fetch service is as often handed to a client
    // (`fetch: ctx.services.parser.fetch`) as called in place.
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.PropertyAccessExpression, (access, file) => {
        const service = surfaceMemberOf(access, "services");

        return edgeRecord(access, file, service === undefined ? undefined : { kind: "invoke", target: service });
    }),
];

export default discoverCallEdges;
