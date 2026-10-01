/**
 * The architecture manifest — `_generated/architecture.json` — the static graph
 * behind the Studio's module catalog and architecture diagram: every function,
 * HTTP route, table, queue, topic, workflow and cron, which module each belongs
 * to, and the edges between them. Built purely from IR codegen already has; an
 * edge it cannot attribute is listed in `unresolved` rather than guessed.
 */
import type { ArchitectureEdge, ArchitectureEdgeKind, ArchitectureManifest, ArchitectureNode, UnresolvedEdge } from "../../../shared/architecture-manifest";
import { moduleOf } from "../../../shared/architecture-manifest";
import { QUEUES_FILENAME } from "./discover/queues";
import { WORKFLOWS_FILENAME } from "./discover/workflows";
import { GENERATED_HEADER } from "./emit";
import type {
    CallEdgeIR,
    CronJobIR,
    FunctionIR,
    HttpRouteIR,
    InsertWriteIR,
    ModuleIR,
    QueryReadIR,
    QueueIR,
    SchemaIR,
    TopicIR,
    WorkflowCallIR,
    WorkflowIR,
} from "./ir";
import renderJsonData from "./json-data";
import sanitizeNamespace from "./paths";

/** The call-site evidence, shared with the advisor so each walk runs once per codegen. */
interface CallSites {
    callEdges: ReadonlyArray<CallEdgeIR>;
    inserts: ReadonlyArray<InsertWriteIR>;
    queries: ReadonlyArray<QueryReadIR>;
    workflowCalls: ReadonlyArray<WorkflowCallIR>;
}

interface ArchitectureInput extends CallSites {
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    modules: ReadonlyArray<ModuleIR>;
    queues: ReadonlyArray<QueueIR>;
    schema: SchemaIR;
    topics: ReadonlyArray<TopicIR>;
    workflows: ReadonlyArray<WorkflowIR>;
}

/**
 * One edge, normalised. A call site names its origin by `file` + `exportName`; a
 * declaration edge (a subscription, a cron target) names it directly in `from`.
 * Exactly one of `to` (a node id) / `reason` is set.
 */
interface PendingEdge {
    exportName: string;
    file: string;
    from?: string;
    kind: ArchitectureEdgeKind;
    line: number;
    reason?: string;
    to?: string;
}

/** The node-id prefix a call-site edge's `target` names. */
const CALL_TARGET_KIND: Readonly<Record<CallEdgeIR["kind"], string>> = { call: "function", enqueue: "queue", publish: "topic", schedule: "function" };

/** The module paths call sites inside `lunora/queues.ts` / `lunora/workflows.ts` handlers carry. */
const QUEUES_MODULE = QUEUES_FILENAME.replace(/\.ts$/u, "");
const WORKFLOWS_MODULE = WORKFLOWS_FILENAME.replace(/\.ts$/u, "");

/** The `namespace:export` key a call site's enclosing declaration resolves through. */
const siteKey = (file: string, exportName: string): string => `${sanitizeNamespace(file)}:${exportName}`;

/** A literal name read off a call site as a node id, or the reason it could not be. */
const literalTarget = (prefix: string, name: string, what: string): Pick<PendingEdge, "reason" | "to"> =>
    name === "" ? { reason: `the ${what} is not a string literal` } : { to: `${prefix}:${name}` };

/** Every call-site input in the one {@link PendingEdge} shape. */
const callSiteEdges = (input: CallSites): PendingEdge[] => [
    ...input.callEdges.map((edge): PendingEdge => {
        const target = edge.target === undefined ? { reason: edge.reason ?? "unreadable target" } : { to: `${CALL_TARGET_KIND[edge.kind]}:${edge.target}` };

        return { exportName: edge.exportName, file: edge.file, kind: edge.kind, line: edge.line, ...target };
    }),
    ...input.queries.map((read): PendingEdge => {
        return { exportName: read.exportName, file: read.file, kind: "read", line: read.line, ...literalTarget("table", read.table, "table name") };
    }),
    ...input.inserts.map((insert): PendingEdge => {
        return { exportName: insert.exportName, file: insert.file, kind: "write", line: insert.line, ...literalTarget("table", insert.table, "table name") };
    }),
    ...input.workflowCalls.map((call): PendingEdge => {
        return { exportName: call.exportName, file: call.file, kind: "start", line: call.line, ...literalTarget("workflow", call.workflow, "workflow name") };
    }),
];

/** Subscription and cron-target edges, which come from declarations rather than call sites. */
const declarationEdges = (input: ArchitectureInput): PendingEdge[] => [
    ...input.queues.flatMap((queue): PendingEdge[] =>
        queue.topic === undefined
            ? []
            : [
                  {
                      exportName: queue.exportName,
                      file: QUEUES_MODULE,
                      from: `topic:${queue.topic}`,
                      kind: "subscribe",
                      line: 0,
                      to: `queue:${queue.exportName}`,
                  },
              ],
    ),
    ...input.crons.map((cron): PendingEdge => {
        const workflowTarget = cron.workflow === undefined ? undefined : `workflow:${cron.workflow.exportName}`;
        const functionTarget = cron.functionPath === undefined ? undefined : `function:${cron.functionPath}`;
        const to = workflowTarget ?? functionTarget;

        return {
            exportName: cron.name,
            file: "crons",
            from: `cron:${cron.name}`,
            kind: "trigger",
            line: 0,
            ...(to === undefined ? { reason: "the cron has no target" } : { to }),
        };
    }),
];

/** Which module owns each table, rejecting a claim on an unknown table or one claimed twice. */
const tableOwners = (modules: ReadonlyArray<ModuleIR>, schema: SchemaIR): Map<string, string> => {
    const known = new Set(schema.tables.map((table) => table.name));
    const owners = new Map<string, string>();

    for (const module of modules) {
        for (const table of module.tables) {
            if (!known.has(table)) {
                throw new Error(`@lunora/codegen: module "${module.name}" declares table "${table}", which lunora/schema.ts does not define`);
            }

            const prior = owners.get(table);

            if (prior !== undefined) {
                throw new Error(`@lunora/codegen: table "${table}" is claimed by both module "${prior}" and module "${module.name}" — a table has one owner`);
            }

            owners.set(table, module.name);
        }
    }

    return owners;
};

/** A node, with `module` present only when it has one (the manifest omits the key otherwise). */
const withModule = (fields: Omit<ArchitectureNode, "module">, module: string | undefined): ArchitectureNode =>
    module === undefined ? fields : { ...fields, module };

/**
 * Every node, plus the call sites that can originate an edge: `namespace:export`
 * of a function, route, queue handler or workflow → its node id.
 */
const buildNodes = (input: ArchitectureInput): { nodes: Map<string, ArchitectureNode>; sites: Map<string, string> } => {
    const nodes = new Map<string, ArchitectureNode>();
    const sites = new Map<string, string>();
    const owners = tableOwners(input.modules, input.schema);
    const add = (entry: ArchitectureNode, site?: string): void => {
        nodes.set(entry.id, entry);

        if (site !== undefined) {
            sites.set(site, entry.id);
        }
    };

    for (const definition of input.functions) {
        const key = siteKey(definition.filePath, definition.exportName);
        const name = `${sanitizeNamespace(definition.filePath)}.${definition.exportName}`;

        add(withModule({ detail: definition.kind, id: `function:${key}`, kind: "function", name }, moduleOf(input.modules, definition.filePath)), key);
    }

    for (const route of input.httpRoutes) {
        const key = siteKey(route.filePath, route.exportName);

        add(withModule({ id: `http:${key}`, kind: "http", name: `${route.method} ${route.path}` }, moduleOf(input.modules, route.filePath)), key);
    }

    for (const table of input.schema.tables) {
        add(withModule({ id: `table:${table.name}`, kind: "table", name: table.name }, owners.get(table.name)));
    }

    // A queue / subscription / workflow handler is a call site too (`message.run(...)`).
    for (const queue of input.queues) {
        const detail = queue.topic === undefined ? {} : { detail: "subscription" };

        add({ ...detail, id: `queue:${queue.exportName}`, kind: "queue", name: queue.exportName }, siteKey(QUEUES_MODULE, queue.exportName));
    }

    for (const topic of input.topics) {
        add({ id: `topic:${topic.exportName}`, kind: "topic", name: topic.exportName });
    }

    for (const workflow of input.workflows) {
        add({ id: `workflow:${workflow.exportName}`, kind: "workflow", name: workflow.exportName }, siteKey(WORKFLOWS_MODULE, workflow.exportName));
    }

    for (const cron of input.crons) {
        add({ detail: cron.cron, id: `cron:${cron.name}`, kind: "cron", name: cron.name });
    }

    return { nodes, sites };
};

/** Why an edge cannot be drawn, or `undefined` when both ends are known nodes. */
const unresolvedReason = (edge: PendingEdge, from: string | undefined, nodes: ReadonlyMap<string, ArchitectureNode>): string | undefined => {
    if (edge.reason !== undefined) {
        return edge.reason;
    }

    if (from === undefined) {
        // `""` / `"<module>"` are the two feeders' "not inside an exported declaration".
        return edge.exportName === "" || edge.exportName === "<module>" ? "inside a non-exported helper" : `"${edge.exportName}" is not a registered function`;
    }

    return edge.to !== undefined && nodes.has(edge.to) ? undefined : `${edge.to ?? "the target"} is not declared`;
};

const edgeKey = (edge: ArchitectureEdge): string => `${edge.from}|${edge.kind}|${edge.to}`;

const buildArchitecture = (input: ArchitectureInput): ArchitectureManifest => {
    const { nodes, sites } = buildNodes(input);
    const edges = new Map<string, ArchitectureEdge>();
    const unresolved: UnresolvedEdge[] = [];

    for (const edge of [...declarationEdges(input), ...callSiteEdges(input)]) {
        const from = edge.from ?? sites.get(siteKey(edge.file, edge.exportName));
        const reason = unresolvedReason(edge, from, nodes);

        if (reason === undefined && from !== undefined && edge.to !== undefined) {
            const drawn = { from, kind: edge.kind, to: edge.to };

            edges.set(edgeKey(drawn), drawn);
        } else {
            unresolved.push({ file: edge.file, kind: edge.kind, line: edge.line, reason: reason ?? "unresolved" });
        }
    }

    return {
        edges: [...edges.values()].toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
        nodes: [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
        modules: input.modules.map((module) => {
            return { ...(module.description === undefined ? {} : { description: module.description }), name: module.name, tables: [...module.tables] };
        }),
        unresolved: unresolved.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
        version: 1,
    };
};

/**
 * The manifest as the importable `_generated/architecture.ts` module the worker
 * passes to `createWorker({ architecture })`, mirroring `emitOpenApiModule`: a
 * Worker cannot read the `.json` at runtime, so the same document is inlined.
 */
const emitArchitectureModule = (manifest: ArchitectureManifest): string =>
    `${GENERATED_HEADER}export const architecture = ${renderJsonData(manifest, "Record<string, unknown>")};\n`;

export type { ArchitectureInput, CallSites };
export { buildArchitecture, emitArchitectureModule };
