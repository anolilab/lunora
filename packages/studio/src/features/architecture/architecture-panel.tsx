import { useLunora } from "@lunora/react";
import type { NodeProps, NodeTypes } from "@xyflow/react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { ChangeEvent, ReactElement } from "react";
import { useMemo, useState } from "react";

import type { ArchitectureEdgeKind, ArchitectureManifest } from "../../../../../shared/architecture-manifest";
import { EDGE_KINDS } from "../../../../../shared/architecture-manifest";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { SpecFetchState } from "../../hooks/use-admin-spec";
import { useAdminSpec } from "../../hooks/use-admin-spec";
import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import { APP_LANE, layoutArchitecture, parseArchitecture } from "./architecture-model";

interface ArchitecturePanelProps {
    /** Inline manifest (the mock harness, or a host holding `_generated/architecture.json`); omitted, the panel fetches it. */
    readonly manifest?: unknown;
}

/** Sentinel `<select>` value for "every module". */
const ALL_MODULES = "*";

/** A module lane: a labelled, dashed container its member nodes sit inside. */
const LaneNode = ({ data }: NodeProps): ReactElement => (
    <div className="size-full rounded-lg border border-dashed border-border bg-background/60 px-3 py-2 text-xs font-medium text-muted-foreground">
        {String(data.label)}
    </div>
);

// Registered once: a narrow custom-node component can't be assigned to React
// Flow's broad `NodeTypes` map without widening, so cast at the single seam.
const NODE_TYPES = { lane: LaneNode } as unknown as NodeTypes;

/** Classify the fetched document: no modules means the app has not opted in yet. */
const classifyManifest = (value: unknown): SpecFetchState<ArchitectureManifest> => {
    const manifest = parseArchitecture(value);

    if (manifest === undefined) {
        return { kind: "error", message: "the response is not an architecture manifest" };
    }

    return manifest.modules.length === 0 ? { kind: "empty" } : { kind: "ready", spec: manifest };
};

/** One row per module (plus the app lane when it has functions): what it is, what it owns, how big it is. */
const ModuleCatalog = ({ manifest }: { readonly manifest: ArchitectureManifest }): ReactElement => {
    const t = useT();
    const functionsIn = (module: string): number => manifest.nodes.filter((node) => node.kind === "function" && (node.module ?? APP_LANE) === module).length;
    const appFunctions = functionsIn(APP_LANE);

    return (
        <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
                <Table data-testid="architecture-catalog">
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("Module")}</TableHead>
                            <TableHead>{t("Description")}</TableHead>
                            <TableHead>{t("Owned tables")}</TableHead>
                            <TableHead>{t("Functions")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {manifest.modules.map((module) => (
                            <TableRow data-testid={`architecture-module-${module.name}`} key={module.name}>
                                <TableCell className="font-mono text-xs">{module.name}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{module.description ?? "—"}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                    {module.tables.length === 0 ? "—" : module.tables.join(", ")}
                                </TableCell>
                                <TableCell className="text-xs">{functionsIn(module.name)}</TableCell>
                            </TableRow>
                        ))}
                        {appFunctions > 0 && (
                            <TableRow data-testid="architecture-module-app">
                                <TableCell className="text-xs italic text-muted-foreground">{t("Outside any module")}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">—</TableCell>
                                <TableCell className="text-xs text-muted-foreground">—</TableCell>
                                <TableCell className="text-xs">{appFunctions}</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
};

/** The module lanes and their edges, filterable by module and edge kind. Read-only. */
const ArchitectureDiagram = ({ manifest }: { readonly manifest: ArchitectureManifest }): ReactElement => {
    const t = useT();
    const [module, setModule] = useState<string>(ALL_MODULES);
    const [kinds, setKinds] = useState<ReadonlySet<ArchitectureEdgeKind>>(() => new Set(EDGE_KINDS));
    const present = EDGE_KINDS.filter((kind) => manifest.edges.some((edge) => edge.kind === kind));
    const appLaneLabel = t("Outside any module");
    // Memoized so ReactFlow is handed the same arrays until a filter changes.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: ReactFlow re-seeds on new node/edge arrays
    const { edges, nodes } = useMemo(
        () => layoutArchitecture(manifest, { appLaneLabel, kinds, ...(module === ALL_MODULES ? {} : { module }) }),
        [manifest, appLaneLabel, kinds, module],
    );

    const onModuleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setModule(event.target.value);
    };
    const toggleKind = (kind: ArchitectureEdgeKind): void => {
        setKinds((previous) => {
            const next = new Set(previous);

            if (!next.delete(kind)) {
                next.add(kind);
            }

            return next;
        });
    };

    return (
        <section className="flex flex-col gap-2" data-testid="architecture-diagram">
            <div className="flex flex-wrap items-center gap-2">
                <select
                    aria-label={t("Module")}
                    className="h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                    data-testid="architecture-module-filter"
                    onChange={onModuleChange}
                    value={module}
                >
                    <option value={ALL_MODULES}>{t("All modules")}</option>
                    {manifest.modules.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                            {entry.name}
                        </option>
                    ))}
                    <option value={APP_LANE}>{t("Outside any module")}</option>
                </select>
                <span className="text-xs text-muted-foreground" data-testid="architecture-edge-count">
                    {t("{count} edges shown", { count: edges.length })}
                </span>
                {present.map((kind) => (
                    <button
                        aria-pressed={kinds.has(kind)}
                        className={cn(
                            "rounded-full border border-border px-2.5 py-0.5 text-xs",
                            kinds.has(kind) ? "bg-muted" : "text-muted-foreground line-through",
                        )}
                        data-testid={`architecture-kind-${kind}`}
                        key={kind}
                        onClick={() => {
                            toggleKind(kind);
                        }}
                        type="button"
                    >
                        {kind}
                    </button>
                ))}
            </div>
            <div className="h-[600px] w-full overflow-hidden border border-border bg-muted/20" data-testid="architecture-canvas">
                <ReactFlow
                    edges={edges}
                    edgesFocusable={false}
                    fitView
                    minZoom={0.1}
                    nodes={nodes}
                    nodesConnectable={false}
                    nodesDraggable={false}
                    nodeTypes={NODE_TYPES}
                >
                    <Background />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </div>
        </section>
    );
};

/**
 * The module catalog and the static architecture diagram codegen derives from
 * `lunora/` — every function, route, table, queue, topic, workflow and cron,
 * grouped by the `defineModule` folder it lives in, with the calls, reads,
 * writes and hand-offs between them. Edges codegen found but could not attach
 * (a reference held in a variable, a call inside a helper) are listed below the
 * diagram rather than guessed.
 */
const ArchitecturePanel = ({ manifest: inlineManifest }: ArchitecturePanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();
    const fetchArchitecture = () => client.fetchArchitecture();
    const state = useAdminSpec<ArchitectureManifest>(inlineManifest, fetchArchitecture, classifyManifest);

    if (state.kind === "loading") {
        return (
            <div className="flex flex-col gap-4" data-testid="architecture-loading">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (state.kind === "error") {
        return (
            <EmptyState
                description={t("Couldn't load the architecture manifest: {message}", { message: state.message })}
                testId="architecture-error"
                title={t("Architecture unavailable")}
            />
        );
    }

    if (state.kind === "empty") {
        return (
            <EmptyState
                description={t("Add a lunora/<folder>/module.ts that default-exports defineModule(...) and run lunora codegen to map your modules here.")}
                testId="architecture-empty"
                title={t("No modules declared")}
            />
        );
    }

    const { spec: manifest } = state;

    return (
        <div className="flex flex-col gap-6" data-testid="architecture-panel">
            <ModuleCatalog manifest={manifest} />
            <ArchitectureDiagram manifest={manifest} />
            {manifest.unresolved.length > 0 && (
                <details className="text-sm" data-testid="architecture-unresolved">
                    <summary className="cursor-pointer text-muted-foreground">
                        {t("{count} call sites could not be drawn", { count: manifest.unresolved.length })}{" "}
                        <Badge variant="outline">{manifest.unresolved.length}</Badge>
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                        {manifest.unresolved.map((entry, index) => (
                            // Two unresolved calls of one kind can share a line, so the index disambiguates.
                            <li key={`${entry.file}:${String(entry.line)}:${entry.kind}:${String(index)}`}>
                                {entry.file}:{entry.line} · {entry.kind} · {entry.reason}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
};

export type { ArchitecturePanelProps };
export default ArchitecturePanel;
