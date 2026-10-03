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
    CallSiteScope,
    CronJobIR,
    FunctionIR,
    HandlerSiteIR,
    HttpRouteIR,
    InsertWriteIR,
    ModuleIR,
    QueryReadIR,
    QueueIR,
    SchemaIR,
    ServiceBindingIR,
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
    /** Sibling Workers bound as services (plan 457); drawn as `service` nodes. */
    services: ReadonlyArray<ServiceBindingIR>;
    topics: ReadonlyArray<TopicIR>;
    workflows: ReadonlyArray<WorkflowIR>;
}

/** Where an edge points: a node id, or why it could not be read. */
type EdgeTarget = { reason: string } | { to: string };

/** Where a pending edge starts: a call-site key, a node id directly, or nowhere (and why). */
type EdgeSource = { exportName: string } | { from: string } | { unattributed: string };

/**
 * One edge, normalised. A call site names its origin by `file` + `exportName`
 * (one pending edge per exported caller); a declaration edge (a subscription, a
 * cron target) names it directly in `from`.
 */
type PendingEdge = EdgeSource &
    EdgeTarget & {
        file: string;
        kind: ArchitectureEdgeKind;
        line: number;
    };

/** One call site before it is fanned out over its callers. */
type CallSite = EdgeTarget & { file: string; kind: ArchitectureEdgeKind; line: number; scope: CallSiteScope };

/** The node-id prefix a call-site edge's `target` names. */
const CALL_TARGET_KIND: Readonly<Record<CallEdgeIR["kind"], string>> = {
    call: "function",
    enqueue: "queue",
    invoke: "service",
    publish: "topic",
    schedule: "function",
};

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

/** Every call-site input in the one {@link CallSite} shape. */
const callSites = (input: ArchitectureInput): CallSite[] => [
    ...input.callEdges.map((edge): CallSite => {
        const target: EdgeTarget =
            edge.target === undefined ? { reason: edge.reason ?? "unreadable target" } : { to: `${CALL_TARGET_KIND[edge.kind]}:${edge.target}` };

        return { file: edge.file, kind: edge.kind, line: edge.line, scope: edge.scope, ...target };
    }),
    ...input.queries.map((read): CallSite => {
        return { file: read.file, kind: "read", line: read.line, scope: read.scope, ...literalTarget("table", read.table, "table name") };
    }),
    ...[...input.inserts, ...input.tableWrites].map((write): CallSite => {
        return { file: write.file, kind: "write", line: write.line, scope: write.scope, ...literalTarget("table", write.table, "written table") };
    }),
    ...input.workflowCalls.map((call): CallSite => {
        return { file: call.file, kind: "start", line: call.line, scope: call.scope, ...literalTarget("workflow", call.workflow, "workflow name") };
    }),
];

/** Why a site no export reaches cannot be drawn. */
const unattributedReason = (scope: Extract<CallSiteScope, { kind: "helper" }>): string =>
    scope.untracked === true ? "inside a helper only code outside any export calls" : "inside a non-exported helper";

/** One call site as a pending edge per exported caller — or one unattributed edge when no export reaches it. */
const pendingEdgesOf = (site: CallSite): PendingEdge[] => {
    const { scope } = site;

    switch (scope.kind) {
        case "export": {
            return [{ ...site, exportName: scope.name }];
        }
        case "helper": {
            return scope.callers.length === 0
                ? [{ ...site, unattributed: unattributedReason(scope) }]
                : scope.callers.map((exportName) => {
                      return { ...site, exportName };
                  });
        }
        default: {
            return [{ ...site, unattributed: "at module scope" }];
        }
    }
};

/** Every call site, fanned out over its callers. */
const callSiteEdges = (input: ArchitectureInput): PendingEdge[] => callSites(input).flatMap((site) => pendingEdgesOf(site));

/** Subscription and cron-target edges, which come from declarations rather than call sites. */
const declarationEdges = (input: ArchitectureInput): PendingEdge[] => [
    ...input.queues.flatMap((queue): PendingEdge[] =>
        queue.topic === undefined
            ? []
            : [
                  {
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
 * of a function, route, queue handler or workflow → its node ids. A handler
 * passed by reference to several queues or workflows originates edges from each.
 */
const buildNodes = (input: ArchitectureInput): { nodes: Map<string, ArchitectureNode>; sites: Map<string, string[]> } => {
    const nodes = new Map<string, ArchitectureNode>();
    const sites = new Map<string, string[]>();
    const owners = tableOwners(input.modules);
    const addSite = (site: string, id: string): void => {
        sites.set(site, [...(sites.get(site) ?? []), id]);
    };
    const add = (entry: ArchitectureNode, site?: string): void => {
        nodes.set(entry.id, entry);

        if (site !== undefined) {
            addSite(site, entry.id);
        }
    };
    // A handler passed by reference (`handler: onboard`) runs its call sites under its own export.
    const addHandlerSite = (site: HandlerSiteIR | undefined, id: string): void => {
        if (site !== undefined) {
            addSite(siteKey(site.file, site.exportName), id);
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
        addHandlerSite(queue.handlerSite, `queue:${queue.exportName}`);
    }

    for (const topic of input.topics) {
        add({ id: `topic:${topic.exportName}`, kind: "topic", name: topic.exportName });
    }

    for (const workflow of input.workflows) {
        add({ id: `workflow:${workflow.exportName}`, kind: "workflow", name: workflow.exportName }, siteKey(WORKFLOWS_MODULE, workflow.exportName));
        addHandlerSite(workflow.handlerSite, `workflow:${workflow.exportName}`);
    }

    for (const cron of input.crons) {
        add({ detail: cron.cron, id: `cron:${cron.name}`, kind: "cron", name: cron.name });
    }

    for (const service of input.services) {
        const style = service.rpcEntrypoint === undefined ? "fetch" : "rpc";

        add({
            detail: service.entrypoint === undefined ? style : `${style} · ${service.entrypoint}`,
            id: `service:${service.name}`,
            kind: "service",
            name: service.worker,
        });
    }

    return { nodes, sites };
};

/** Why a call site's export has no source node: it registers nothing. */
const missingSourceReason = (exportName: string): string =>
    exportName === "default" ? "the default export is not a registered function" : `"${exportName}" is not a registered function`;

/** The node ids an edge starts from, or the reason it has none. */
const sourcesOf = (edge: PendingEdge, sites: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> | { reason: string } => {
    if ("from" in edge) {
        return [edge.from];
    }

    if ("unattributed" in edge) {
        return { reason: edge.unattributed };
    }

    return sites.get(siteKey(edge.file, edge.exportName)) ?? { reason: missingSourceReason(edge.exportName) };
};

/** The drawn edges, or the reason the edge cannot be drawn. */
const resolveEdge = (
    edge: PendingEdge,
    sites: ReadonlyMap<string, ReadonlyArray<string>>,
    nodes: ReadonlyMap<string, ArchitectureNode>,
): { drawn: ArchitectureEdge[] } | { reason: string } => {
    if ("reason" in edge) {
        return { reason: edge.reason };
    }

    const sources = sourcesOf(edge, sites);

    if ("reason" in sources) {
        return sources;
    }

    const { to } = edge;

    return nodes.has(to)
        ? {
              drawn: sources.map((from) => {
                  return { from, kind: edge.kind, to };
              }),
          }
        : { reason: `${to} is not declared` };
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
            for (const drawn of result.drawn) {
                edges.set(edgeKey(drawn), drawn);
            }
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
                ...(entry.ownsFolder === false ? { ownsFolder: false as const } : {}),
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
