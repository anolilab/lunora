import type { Block, CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CallEdgeIR } from "../ir";
import { collectCallRows, collectNodeRows, functionKeyOf, isFunctionLike, RUN_METHODS } from "./ast";
import { callSiteScopeOf } from "./attribution";

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
        ? { kind: "call", reason: "the function reference is not a static api.* / internal.* chain" }
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
        const target = functionKeyOf(second);

        return target === undefined
            ? { kind: "schedule", reason: "the scheduled function is not a static api.* / internal.* chain" }
            : { kind: "schedule", target };
    }

    const producer = SURFACE_METHODS.get(method);
    const target = producer === undefined ? undefined : surfaceMemberOf(callee, producer.surface);

    return producer === undefined || target === undefined ? undefined : { kind: producer.kind, target };
};

/**
 * An ancestor that only ever runs its body conditionally — a branch, a loop
 * (which may iterate zero times), a `switch` arm, or a `try`/`catch`/`finally`
 * block (which a throw may skip; `finally` needs no kind of its own, its block
 * hangs off the `TryStatement`). A call under any of them may never fire.
 */
const CONDITIONAL_ANCESTORS: ReadonlySet<SyntaxKind> = new Set<SyntaxKind>([
    SyntaxKind.CaseClause,
    SyntaxKind.CatchClause,
    SyntaxKind.DefaultClause,
    SyntaxKind.DoStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.IfStatement,
    SyntaxKind.SwitchStatement,
    SyntaxKind.TryStatement,
    SyntaxKind.WhileStatement,
]);

/** Logical operators, whose right operand is evaluated only when the left one allows it. */
const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set<SyntaxKind>([
    SyntaxKind.AmpersandAmpersandEqualsToken,
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarEqualsToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionEqualsToken,
    SyntaxKind.QuestionQuestionToken,
]);

/**
 * A preceding sibling that leaves the block — an early exit, a guard that may
 * take it, a loop that may never finish — so whatever follows runs only when it
 * doesn't. This is what keeps `if (done()) return; ctx.scheduler.runAfter(…)`
 * out of a dispatch cycle: the reschedule is a *sibling* of that guard, not
 * beneath it, so no ancestor walk would ever see it.
 *
 * Over-approximated on purpose: a preceding `if` whose branch does NOT exit
 * (`if (log) console.log(…)`) still marks what follows conditional. That costs
 * the lint a cycle it might otherwise flag and buys the absence of a false
 * build-blocking ERROR — the right trade for a rule whose whole claim is that
 * it cannot cry wolf.
 */
const EXITING_SIBLINGS: ReadonlySet<SyntaxKind> = new Set<SyntaxKind>([
    SyntaxKind.BreakStatement,
    SyntaxKind.ContinueStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.IfStatement,
    SyntaxKind.ReturnStatement,
    SyntaxKind.ThrowStatement,
    SyntaxKind.WhileStatement,
]);

/** `true` when a statement of `block` ending before `child` starts may take control away from it. */
const precededByExit = (block: Block, child: TsNode): boolean =>
    block.getStatements().some((statement) => statement.getEnd() <= child.getStart() && EXITING_SIBLINGS.has(statement.getKind()));

/** `true` when `child` sits in `parent` at a position that does not run on every pass. */
const conditionalPosition = (child: TsNode, parent: TsNode): boolean => {
    if (CONDITIONAL_ANCESTORS.has(parent.getKind())) {
        return true;
    }

    // A function nested in another — `items.forEach(() => …)`, a `.then(…)`, a
    // local closure — runs only if, and as often as, something calls it. The
    // outermost function (the handler, a top-level helper) is the one that runs.
    if (isFunctionLike(parent)) {
        return parent.getFirstAncestor(isFunctionLike) !== undefined;
    }

    // `cond ? a : b` — only the arm taken runs; the condition itself is no guard.
    if (Node.isConditionalExpression(parent)) {
        return child !== parent.getCondition();
    }

    // `a && b()` / `a ?? b()` — `b` runs only when `a` leaves room for it.
    if (Node.isBinaryExpression(parent)) {
        return child !== parent.getLeft() && LOGICAL_OPERATORS.has(parent.getOperatorToken().getKind());
    }

    // `a?.b(…)` / `a.b?.(…)` — the member/call runs only when the receiver is present.
    if (Node.isQuestionDotTokenable(child)) {
        return child.hasQuestionDotToken();
    }

    return Node.isBlock(parent) && precededByExit(parent, child);
};

/**
 * `true` when the site's own receiver chain may short-circuit —
 * `ctx.scheduler?.runAfter(…)`, `ctx.services.billing?.charge` — so the call
 * runs only when every link is present. The chain hangs BELOW the site, where
 * the ancestor walk never looks.
 */
const isOptionalChain = (site: TsNode): boolean => {
    let current: TsNode = site;

    while (Node.isCallExpression(current) || Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
        if (current.hasQuestionDotToken()) {
            return true;
        }

        current = current.getExpression();
    }

    return false;
};

/**
 * `true` when the site sits behind a guard — walked from the site out to its
 * `SourceFile` rather than to the nearest function, so a guard ABOVE the
 * callback holding the site (`if (enabled) { const work = () => … }`) is seen
 * as well as one inside it.
 */
const isConditionalSite = (site: TsNode): boolean => {
    if (isOptionalChain(site)) {
        return true;
    }

    let child: TsNode = site;

    for (;;) {
        const parent = child.getParent();

        if (parent === undefined || Node.isSourceFile(parent)) {
            return false;
        }

        if (conditionalPosition(child, parent)) {
            return true;
        }

        child = parent;
    }
};

/** The {@link CallEdgeIR} of a site, or `undefined` when it carries no edge. */
const edgeRecord = (site: TsNode, file: string, edge: CallSiteEdge | undefined): CallEdgeIR | undefined =>
    edge === undefined
        ? undefined
        : {
              ...edge,
              ...(isConditionalSite(site) ? { conditional: true as const } : {}),
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
