/**
 * The architecture manifest — `_generated/architecture.json` — shared by the
 * codegen that builds it, the runtime that serves it at
 * `GET /_lunora/admin/architecture`, the client that fetches it and the studio
 * that draws it. Also the one place the module-membership rule lives.
 *
 * Bundler-inlined `shared/` source: zero dependencies, named exports only.
 */

/** The resources a node can stand for. */
export type ArchitectureNodeKind = "cron" | "function" | "http" | "queue" | "table" | "topic" | "workflow";

/** How two nodes relate. */
export type ArchitectureEdgeKind = "call" | "enqueue" | "publish" | "read" | "schedule" | "start" | "subscribe" | "trigger" | "write";

export interface ArchitectureNode {
    /** Short qualifier: a function's kind (`query`, …), `subscription` for a topic's queue, a cron's schedule. */
    detail?: string;
    /** Stable id, `<kind>:<identity>` (`function:billing_invoices:create`, `table:invoices`). */
    id: string;
    kind: ArchitectureNodeKind;
    /** Display name: the `api.*` path, the route, the table or export name. */
    name: string;
    /** The owning module; absent for a node outside every module. */
    module?: string;
}

export interface ArchitectureEdge {
    from: string;
    kind: ArchitectureEdgeKind;
    to: string;
}

/** An edge codegen found but could not attach to the graph. */
export interface UnresolvedEdge {
    /** `lunora/`-relative file of the call site. */
    file: string;
    kind: ArchitectureEdgeKind;
    line: number;
    reason: string;
}

export interface ArchitectureModule {
    description?: string;
    /** `true` for an installed component (a schema extension) shown as a module. */
    installed?: true;
    name: string;
    tables: string[];
}

export interface ArchitectureManifest {
    edges: ArchitectureEdge[];
    nodes: ArchitectureNode[];
    modules: ArchitectureModule[];
    unresolved: UnresolvedEdge[];
    version: 1;
}

/** Every edge kind, in the order the studio's filter lists them. */
export const EDGE_KINDS: ReadonlyArray<ArchitectureEdgeKind> = ["call", "schedule", "read", "write", "enqueue", "publish", "subscribe", "start", "trigger"];

/** The manifest of an app that declares no module. */
export const EMPTY_ARCHITECTURE: Readonly<ArchitectureManifest> = Object.freeze({ edges: [], nodes: [], modules: [], unresolved: [], version: 1 });

/**
 * The module a `lunora/`-relative module path (`billing/invoices`, no extension)
 * belongs to, or `undefined` outside every module. Membership is "inside the
 * folder": `lunora/billing.ts` (path `billing`) sits beside the `billing` folder
 * and is not part of it.
 */
export const moduleOf = (modules: ReadonlyArray<{ name: string }>, file: string): string | undefined =>
    modules.find((module) => file.startsWith(`${module.name}/`))?.name;
