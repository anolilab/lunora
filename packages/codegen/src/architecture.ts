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
    TableWriteIR,
    TopicIR,
    WorkflowCallIR,
    WorkflowIR,
} from "./ir";
import renderJsonData from "./json-data";
import sanitizeNamespace from "./paths";

/** The call-site evidence, shared with the advisor so each walk runs once per codegen. */
interface CallSites {
    inserts: ReadonlyArray<InsertWriteIR>;
    queries: ReadonlyArray<QueryReadIR>;
    /** Writes other than a plain `ctx.db.insert` — by id, batch, and the `ctx.db.<table>` facade. */
    tableWrites: ReadonlyArray<TableWriteIR>;
    workflowCalls: ReadonlyArray<WorkflowCallIR>;
}

interface ArchitectureInput extends CallSites {
    callEdges: ReadonlyArray<CallEdgeIR>;
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    modules: ReadonlyArray<ModuleIR>;
    queues: ReadonlyArray<QueueIR>;
    schema: SchemaIR;
    topics: ReadonlyArray<TopicIR>;
    workflows: ReadonlyArray<WorkflowIR>;
}

/** Where an edge points: a node id, or why it could not be read. */
type EdgeTarget = { reason: string } | { to: string };

/**
 * One edge, normalised. A call site names its origin by `file` + `exportName`; a
 * declaration edge (a subscription, a cron target) names it directly in `from`.
 */
type PendingEdge = EdgeTarget & {
    exportName: string;
    file: string;
    from?: string;
    kind: ArchitectureEdgeKind;
    line: number;
};

/** The node-id prefix a call-site edge's `target` names. */
const CALL_TARGET_KIND: Readonly<Record<CallEdgeIR["kind"], string>> = { call: "function", enqueue: "queue", publish: "topic", schedule: "function" };

/** The module paths call sites inside `lunora/queues.ts` / `lunora/workflows.ts` handlers carry. */
const QUEUES_MODULE = QUEUES_FILENAME.replace(/\.ts$/u, "");
/** `cronJobs()` is registered from `lunora/crons.ts`; a cron edge reports against it. */
const CRONS_MODULE = "crons";
const WORKFLOWS_MODULE = WORKFLOWS_FILENAME.replace(/\.ts$/u, "");

/** The `namespace:export` key a call site's enclosing declaration resolves through. */
const siteKey = (file: string, exportName: string): string => `${sanitizeNamespace(file)}:${exportName}`;

/** A literal name read off a call site as a node id, or the reason it could not be. */
const literalTarget = (prefix: string, name: string, what: string): EdgeTarget =>
    name === "" ? { reason: `the ${what} is not a string literal` } : { to: `${prefix}:${name}` };

/** Every call-site input in the one {@link PendingEdge} shape. */
const callSiteEdges = (input: ArchitectureInput): PendingEdge[] => [
    ...input.callEdges.map((edge): PendingEdge => {
        const target: EdgeTarget =
            edge.target === undefined ? { reason: edge.reason ?? "unreadable target" } : { to: `${CALL_TARGET_KIND[edge.kind]}:${edge.target}` };

        return { exportName: edge.exportName, file: edge.file, kind: edge.kind, line: edge.line, ...target };
    }),
    ...input.queries.map((read): PendingEdge => {
        return { exportName: read.exportName, file: read.file, kind: "read", line: read.line, ...literalTarget("table", read.table, "table name") };
    }),
    ...[...input.inserts, ...input.tableWrites].map((write): PendingEdge => {
        return { exportName: write.exportName, file: write.file, kind: "write", line: write.line, ...literalTarget("table", write.table, "written table") };
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
            file: CRONS_MODULE,
            from: `cron:${cron.name}`,
            kind: "trigger",
            line: 0,
            ...(to === undefined ? { reason: "the cron has no target" } : { to }),
        };
    }),
];

/** Which module owns each table — already validated (one owner, known table) by `resolveModules`. */
const tableOwners = (modules: ReadonlyArray<ModuleIR>): Map<string, string> =>
    new Map(modules.flatMap((entry) => entry.tables.map((table) => [table, entry.name] as const)));

/** A node, with `module` present only when it has one (the manifest omits the key otherwise). */
const withModule = (fields: Omit<ArchitectureNode, "module">, moduleName: string | undefined): ArchitectureNode =>
    moduleName === undefined ? fields : { ...fields, module: moduleName };

/**
 * Every node, plus the call sites that can originate an edge: `namespace:export`
 * of a function, route, queue handler or workflow → its node id.
 */
const buildNodes = (input: ArchitectureInput): { nodes: Map<string, ArchitectureNode>; sites: Map<string, string> } => {
    const nodes = new Map<string, ArchitectureNode>();
    const sites = new Map<string, string>();
    const owners = tableOwners(input.modules);
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

/** Why a call site has no source node: outside every export, or inside one that registers nothing. */
const missingSourceReason = (exportName: string): string => {
    if (exportName === "") {
        return "inside a non-exported helper";
    }

    return exportName === "default" ? "the default export is not a registered function" : `"${exportName}" is not a registered function`;
};

/** The drawn edge, or the reason it cannot be drawn. */
const resolveEdge = (
    edge: PendingEdge,
    sites: ReadonlyMap<string, string>,
    nodes: ReadonlyMap<string, ArchitectureNode>,
): { drawn: ArchitectureEdge } | { reason: string } => {
    if ("reason" in edge) {
        return { reason: edge.reason };
    }

    const from = edge.from ?? sites.get(siteKey(edge.file, edge.exportName));

    if (from === undefined) {
        return { reason: missingSourceReason(edge.exportName) };
    }

    return nodes.has(edge.to) ? { drawn: { from, kind: edge.kind, to: edge.to } } : { reason: `${edge.to} is not declared` };
};

const edgeKey = (edge: ArchitectureEdge): string => `${edge.from}|${edge.kind}|${edge.to}`;

const unresolvedKey = (entry: UnresolvedEdge): string => `${entry.file}|${String(entry.line)}|${entry.kind}|${entry.reason}`;

const buildArchitecture = (input: ArchitectureInput): ArchitectureManifest => {
    const { nodes, sites } = buildNodes(input);
    const edges = new Map<string, ArchitectureEdge>();
    // Keyed so two identical call sites on one line (`ctx.runQuery(a); ctx.runQuery(b)`
    // with unreadable refs) report once — the studio keys its list rows on this.
    const unresolved = new Map<string, UnresolvedEdge>();

    for (const edge of [...declarationEdges(input), ...callSiteEdges(input)]) {
        const result = resolveEdge(edge, sites, nodes);

        if ("drawn" in result) {
            edges.set(edgeKey(result.drawn), result.drawn);
        } else {
            const entry = { file: edge.file, kind: edge.kind, line: edge.line, reason: result.reason };

            unresolved.set(unresolvedKey(entry), entry);
        }
    }

    return {
        edges: [...edges.values()].toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
        nodes: [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
        modules: input.modules.map((entry) => {
            return {
                ...(entry.description === undefined ? {} : { description: entry.description }),
                ...(entry.installed === true ? { installed: true as const } : {}),
                name: entry.name,
                tables: [...entry.tables],
            };
        }),
        unresolved: [...unresolved.values()].toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
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
