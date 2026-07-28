import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Edge, Node, NodeProps, NodeTypes } from "@xyflow/react";
import { Background, Controls, Handle, Position, ReactFlow } from "@xyflow/react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface Binding {
    name: string;
    target?: string;
    type: string;
}

/** Human labels for the wrangler binding kinds. */
const TYPE_LABEL: Record<string, string> = {
    ai: "Workers AI",
    analytics: "Analytics Engine",
    assets: "Assets",
    container: "Container",
    d1: "D1 Database",
    durable_object: "Durable Object",
    hyperdrive: "Hyperdrive",
    kv: "KV Namespace",
    queue: "Queue",
    r2: "R2 Bucket",
    secret: "Secret",
    service: "Service",
    var: "Var",
    vectorize: "Vectorize",
    workflow: "Workflow",
};

/** A colour per binding kind — used for the type dot + edge (nodes stay monochrome). */
const TYPE_COLOR: Record<string, string> = {
    ai: "#ec4899",
    analytics: "#22c55e",
    assets: "#f97316",
    container: "#0ea5e9",
    d1: "#f59e0b",
    durable_object: "#8b5cf6",
    hyperdrive: "#14b8a6",
    kv: "#3b82f6",
    queue: "#10b981",
    r2: "#f97316",
    secret: "#64748b",
    service: "#06b6d4",
    var: "#64748b",
    vectorize: "#a855f7",
    workflow: "#6366f1",
};

/** One-line description of what each binding kind is. */
const TYPE_DESC: Record<string, string> = {
    ai: "Run machine-learning models on Cloudflare's global GPU network.",
    analytics: "Write high-cardinality events for time-series analytics.",
    assets: "Serve static assets bundled alongside the Worker.",
    container: "Run a container image next to the Worker.",
    d1: "A serverless SQLite database, replicated at the edge.",
    durable_object: "A single-instance, strongly-consistent stateful coordinator.",
    hyperdrive: "Pooled, cached access to an external Postgres or MySQL database.",
    kv: "A low-latency, eventually-consistent key-value store.",
    queue: "A message queue for asynchronous, batched processing.",
    r2: "S3-compatible object storage with zero egress fees.",
    secret: "An encrypted secret injected at runtime — never stored in code.",
    service: "A direct binding to call another Worker (service binding).",
    var: "A plaintext environment variable from the wrangler config.",
    vectorize: "A vector database for embeddings and similarity search.",
    workflow: "A durable, multi-step workflow with automatic retries.",
};

/** Cloudflare docs entry point per binding kind. */
const TYPE_DOCS: Record<string, string> = {
    ai: "https://developers.cloudflare.com/workers-ai/",
    analytics: "https://developers.cloudflare.com/analytics/analytics-engine/",
    assets: "https://developers.cloudflare.com/workers/static-assets/",
    container: "https://developers.cloudflare.com/containers/",
    d1: "https://developers.cloudflare.com/d1/",
    durable_object: "https://developers.cloudflare.com/durable-objects/",
    hyperdrive: "https://developers.cloudflare.com/hyperdrive/",
    kv: "https://developers.cloudflare.com/kv/",
    queue: "https://developers.cloudflare.com/queues/",
    r2: "https://developers.cloudflare.com/r2/",
    secret: "https://developers.cloudflare.com/workers/configuration/secrets/",
    service: "https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/",
    var: "https://developers.cloudflare.com/workers/configuration/environment-variables/",
    vectorize: "https://developers.cloudflare.com/vectorize/",
    workflow: "https://developers.cloudflare.com/workflows/",
};

/** A short "how you'd use this binding in the Worker" code snippet. */
const ACCESS: Record<string, (name: string, target?: string) => string> = {
    ai: (name) => `const res = await env.${name}.run(\n  "@cf/meta/llama-3.1-8b-instruct",\n  { prompt: "Hello" },\n);`,
    d1: (name) => `const { results } = await env.${name}\n  .prepare("SELECT * FROM users LIMIT 10")\n  .all();`,
    durable_object: (name) => `const id = env.${name}.idFromName("room-42");\nconst stub = env.${name}.get(id);`,
    hyperdrive: (name) => `const sql = postgres(env.${name}.connectionString);`,
    kv: (name) => `const value = await env.${name}.get("session:42");`,
    queue: (name) => `await env.${name}.send({ userId: 42 });`,
    r2: (name) => `const object = await env.${name}.get("uploads/logo.png");`,
    secret: (name) => `// injected at runtime — never commit it\nconst apiKey = env.${name};`,
    service: (name) => `const res = await env.${name}.fetch(request);`,
    var: (name, target) => `const value = env.${name}; // "${target ?? ""}"`,
    vectorize: (name) => `const matches = await env.${name}.query(vector, {\n  topK: 5,\n});`,
};

const colorFor = (type: string): string => TYPE_COLOR[type] ?? "#64748b";
const documentationFor = (type: string): string => TYPE_DOCS[type] ?? "https://developers.cloudflare.com/workers/runtime-apis/bindings/";
const accessSnippet = (binding: Binding): string => (ACCESS[binding.type] ?? ((name: string) => `const value = env.${name};`))(binding.name, binding.target);

type BindingNodeType = Node<{ binding: Binding }, "binding">;
type WorkerNodeType = Node<{ label: string }, "worker">;

/** The project's Worker — the graph's single source node. */
const WorkerNode = ({ data }: NodeProps<WorkerNodeType>): ReactElement => (
    <div className="flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background">
        <span className="grid size-5 shrink-0 place-items-center rounded bg-background/20 font-mono text-[10px]">W</span>
        <span className="max-w-40 truncate">{data.label}</span>
        <Handle position={Position.Right} style={{ background: "var(--foreground)" }} type="source" />
    </div>
);

/** A single bound resource — click to open its detail sheet. */
const BindingNode = ({ data }: NodeProps<BindingNodeType>): ReactElement => (
    <div className="flex min-w-44 cursor-pointer flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-foreground/40">
        <Handle position={Position.Left} style={{ background: "var(--muted-foreground)" }} type="target" />
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(data.binding.type) }} />
            {TYPE_LABEL[data.binding.type] ?? data.binding.type}
        </span>
        <span className="text-sm font-medium">{data.binding.name}</span>
        {data.binding.target ? <span className="truncate font-mono text-xs text-muted-foreground">{data.binding.target}</span> : null}
    </div>
);

const NODE_TYPES: NodeTypes = { binding: BindingNode, worker: WorkerNode };

/** The detail panel for a clicked binding — description, how to use it, and docs. */
const BindingSheet = ({ binding, onClose }: { binding: Binding | null; onClose: () => void }): ReactElement => (
    <Sheet
        onOpenChange={(next) => {
            if (!next) {
                onClose();
            }
        }}
        open={binding !== null}
    >
        <SheetContent className="w-full gap-0 sm:max-w-md" side="right">
            {binding ? (
                <>
                    <SheetHeader>
                        <span className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase">
                            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(binding.type) }} />
                            {TYPE_LABEL[binding.type] ?? binding.type}
                        </span>
                        <SheetTitle className="font-mono">{binding.name}</SheetTitle>
                        <SheetDescription>{TYPE_DESC[binding.type] ?? "A Cloudflare Worker binding."}</SheetDescription>
                    </SheetHeader>

                    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
                        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
                            <dt className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Variable</dt>
                            <dd className="font-mono">env.{binding.name}</dd>
                            {binding.target ? (
                                <>
                                    <dt className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Resource</dt>
                                    <dd className="truncate font-mono">{binding.target}</dd>
                                </>
                            ) : null}
                            <dt className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Kind</dt>
                            <dd>{TYPE_LABEL[binding.type] ?? binding.type}</dd>
                        </dl>

                        <div className="grid gap-1.5">
                            <span className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Access in your Worker</span>
                            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                                {accessSnippet(binding)}
                            </pre>
                        </div>
                    </div>

                    <SheetFooter className="border-t">
                        <a
                            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline"
                            href={documentationFor(binding.type)}
                            rel="noreferrer"
                            target="_blank"
                        >
                            Learn more
                            <HugeiconsIcon className="size-3.5" icon={ArrowUpRight01Icon} strokeWidth={2} />
                        </a>
                    </SheetFooter>
                </>
            ) : null}
        </SheetContent>
    </Sheet>
);

/**
 * A React Flow diagram of a deployment's wrangler bindings — the Worker on the
 * left with an edge to every connected resource (D1, KV, R2, queues, Durable
 * Objects, services, AI, …). Click any resource to open a detail sheet with what
 * it is, how to use it, and a link into the Cloudflare docs.
 */
export const ProjectGraph = ({ bindings, projectName }: { bindings: Binding[]; projectName: string }): ReactElement => {
    const [selected, setSelected] = useState<Binding | null>(null);

    const nodes = useMemo<Node[]>(() => {
        const rows = Math.max(1, Math.ceil(bindings.length / 2));

        return [
            { data: { label: projectName }, id: "worker", position: { x: 0, y: (rows - 1) * 44 }, type: "worker" },
            ...bindings.map((binding, index) => {
                return {
                    data: { binding },
                    id: `binding-${String(index)}`,
                    position: { x: 280 + (index % 2) * 230, y: Math.floor(index / 2) * 88 },
                    type: "binding",
                };
            }),
        ];
    }, [bindings, projectName]);

    const edges = useMemo<Edge[]>(
        () =>
            bindings.map((binding, index) => {
                return {
                    id: `edge-${String(index)}`,
                    source: "worker",
                    // Soft, low-saturation edges — the type dot on each node carries the colour.
                    style: { stroke: colorFor(binding.type), strokeOpacity: 0.5, strokeWidth: 1.5 },
                    target: `binding-${String(index)}`,
                };
            }),
        [bindings],
    );

    return (
        <>
            <div className="h-[420px] w-full overflow-hidden rounded-lg border border-border bg-muted/20">
                <ReactFlow
                    edges={edges}
                    fitView
                    fitViewOptions={{ padding: 0.18 }}
                    minZoom={0.2}
                    nodes={nodes}
                    nodesConnectable={false}
                    nodesDraggable={false}
                    nodeTypes={NODE_TYPES}
                    onNodeClick={(_event, node) => {
                        if (node.type === "binding") {
                            setSelected((node.data as { binding: Binding }).binding);
                        }
                    }}
                    panOnScroll={false}
                    preventScrolling={false}
                    zoomOnScroll={false}
                >
                    <Background />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </div>
            <BindingSheet
                binding={selected}
                onClose={() => {
                    setSelected(null);
                }}
            />
        </>
    );
};
