import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CallEdgeIR } from "../ir";
import sanitizeNamespace from "../paths";
import { collectCallRows, collectNodeRows, functionReferenceSegments, RUN_METHODS } from "./ast";
import { callSiteScopeOf } from "./attribution";

/**
 * A function reference as the `namespace:export` key the function registry uses.
 * The emitted api is flat (`api.billing_invoices.create`), and a nested chain
 * (`api.billing.invoices.create`) is folded the same way `sanitizeNamespace` folds
 * the file path, so both spellings land on the same key.
 */
const functionKeyOf = (node: TsNode | undefined): string | undefined => {
    const segments = functionReferenceSegments(node);

    return segments === undefined ? undefined : `${sanitizeNamespace(segments.slice(0, -1).join("/"))}:${String(segments.at(-1))}`;
};

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

/** The {@link CallEdgeIR} of a site, or `undefined` when it carries no edge. */
const edgeRecord = (site: TsNode, file: string, edge: CallSiteEdge | undefined): CallEdgeIR | undefined =>
    edge === undefined ? undefined : { ...edge, file, line: site.getStartLineNumber(), scope: callSiteScopeOf(site) };

/**
 * Discover the call-site edges of the architecture graph: every function →
 * function call (`ctx.run*`), scheduled dispatch (`ctx.scheduler.runAfter/runAt`),
 * enqueue (`ctx.queues.<q>.send`), topic publish (`ctx.topics.<t>.publish`) and
 * service use (`ctx.services.<s>.<member>`; a destructured `ctx.services` is not seen) in
 * `lunora/`, one record per site with its `CallSiteScope`. Purely syntactic
 * — no type checker — so a reference held in a variable is recorded with a
 * `reason` instead of a `target`; the manifest builder reports it, and a site no
 * export reaches, rather than guessing.
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
