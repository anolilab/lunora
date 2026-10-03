import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CallEdgeIR } from "../ir";
import sanitizeNamespace from "../paths";
import { exportAttributionsOf, functionReferenceSegments, listLunoraSourceFiles, lunoraRelativePath, RUN_METHODS } from "./ast";

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

type CallSiteEdge = Omit<CallEdgeIR, "exportName" | "file" | "line">;

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
 * Discover the call-site edges of the architecture graph: every function →
 * function call (`ctx.run*`), scheduled dispatch (`ctx.scheduler.runAfter/runAt`),
 * enqueue (`ctx.queues.<q>.send`), topic publish (`ctx.topics.<t>.publish`) and
 * service use (`ctx.services.<s>.<member>`; a destructured `ctx.services` is not seen) in
 * `lunora/`, attributed to the exported declaration it sits in. Purely syntactic
 * — no type checker — so a reference held in a variable is recorded with a
 * `reason` instead of a `target`. A call inside a same-file helper is recorded once
 * per export that reaches the helper (see `enclosingExportNames`); one no export
 * reaches carries `exportName: ""`, and the manifest builder reports it rather
 * than guessing.
 */
const discoverCallEdges = (project: Project, lunoraDirectory: string): CallEdgeIR[] => {
    const edges: CallEdgeIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const file = lunoraRelativePath(lunoraDirectory, filePath);

        // One edge per export the site is attributed to, all at the site's own line.
        const record = (site: TsNode, edge: CallSiteEdge): void => {
            for (const { exportName } of exportAttributionsOf(site)) {
                edges.push({ ...edge, exportName, file, line: site.getStartLineNumber() });
            }
        };

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const edge = edgeOf(call);

            if (edge !== undefined) {
                record(call, edge);
            }
        }

        // `ctx.services.<name>.<member>`, called or not: an RPC method has an
        // arbitrary name, and a fetch service is as often handed to a client
        // (`fetch: ctx.services.parser.fetch`) as called in place.
        for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
            const service = surfaceMemberOf(access, "services");

            if (service !== undefined) {
                record(access, { kind: "invoke", target: service });
            }
        }
    }

    return edges;
};

export default discoverCallEdges;
