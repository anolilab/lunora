import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import type { TablePage } from "../../lib/admin";
import type { AdvisorRelation, AdvisorSchema } from "../../lib/cascade-schema";
import { buildCascadeMap, walkCascade } from "../../lib/cascade-schema";
import { fireAndForget } from "../../lib/internal";

/**
 * The maximum cascade depth the preview walks. Beyond this depth the walk stops
 * and the cap is surfaced to the operator — no silent truncation.
 */
const MAX_DEPTH = 6;

/**
 * The maximum row count fetched per table in the cascade preview. The actual
 * query caps to this; any overflow is noted — never silently truncated.
 */
const MAX_ROWS_PER_TABLE = 100;

/** One node in the cascade impact tree, resolved against live data. */
interface CascadeNode {
    /** Message shown when the cap was reached — undefined when within limits. */
    capNote: string | undefined;
    /** Child impact nodes (tables the deletes cascade or block to). */
    children: CascadeNode[];
    /** Whether this relation blocks the delete (restrict) vs cascades. */
    isRestrict: boolean;
    /** The relation that caused this node to appear (undefined for the root). */
    relation: AdvisorRelation | undefined;
    /** Total count of matching rows (may exceed MAX_ROWS_PER_TABLE). */
    rowCount: number;
    /** Sample matching row ids (up to MAX_ROWS_PER_TABLE). */
    rowIds: string[];
    /** Name of the table at this level. */
    table: string;
}

/** Props for the cascade preview dialog. */
interface CascadePreviewProps {
    /** Dismiss without deleting. */
    readonly onClose: () => void;
    /** Called when the operator confirms delete. */
    readonly onConfirm: () => void;
    /** Async read of a table page (bounded). Used to count/sample matching rows. */
    readonly readPage: (table: string, search: string) => Promise<TablePage>;
    /** Row id being deleted. */
    readonly rowId: string;
    /** The advisor schema describing all tables and their relations. */
    readonly schema: AdvisorSchema;
    /** The table the row being deleted belongs to. */
    readonly table: string;
}

/** Indentation style object — computed once per depth level. */
const rowStyle = (depth: number): { paddingLeft: number } => {
    return { paddingLeft: depth * 16 };
};

/** The restrict badge for relations that block deletion. */
const RestrictBadge = ({ table }: { table: string }): ReactElement => (
    <span className="rounded bg-destructive/10 px-1 text-destructive" data-testid={`cascade-restrict-${table}`}>
        restrict — will block delete
    </span>
);

/** The cascade badge for relations that cascade deletes down. */
const CascadeBadge = ({ table }: { table: string }): ReactElement => (
    <span className="rounded bg-warning/10 px-1 text-warning" data-testid={`cascade-cascade-${table}`}>
        cascade
    </span>
);

/**
 * One line of the cascade tree: an indented row showing the table, row count,
 * restrict/cascade badge, and any cap note.
 */
const CascadeRow = ({ depth, node }: { depth: number; node: CascadeNode }): ReactElement => (
    <>
        <li className="flex flex-wrap items-center gap-1.5 py-1 font-mono text-xs" data-testid={`cascade-row-${node.table}`} style={rowStyle(depth)}>
            {depth > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                    └
                </span>
            )}
            <span className="font-medium text-foreground">{node.table}</span>
            <span className="text-muted-foreground">({node.rowCount.toString()} rows)</span>
            {node.isRestrict ? <RestrictBadge table={node.table} /> : <CascadeBadge table={node.table} />}
            {node.capNote !== undefined && (
                <span className="italic text-muted-foreground" data-testid={`cascade-cap-${node.table}`}>
                    ({node.capNote})
                </span>
            )}
        </li>
        {node.children.map((child, index) => (
            // Key includes the index because the cascade walk pushes one child
            // per sampled parent row id, so several children can share the same
            // `(table, relation.field)` pair — without a per-instance
            // disambiguator React collapses them and warns.
            <CascadeRow depth={depth + 1} key={`${child.table}-${child.relation?.field ?? "root"}-${index.toString()}`} node={child} />
        ))}
    </>
);

/** Extract a string row-id from the raw row object, trying several common id fields. */
const extractRowId = (row: Record<string, unknown>): string => {
    const raw = row["_id"] ?? row["id"] ?? row["__id__"] ?? "";

    if (typeof raw === "string") {
        return raw;
    }

    if (typeof raw === "number") {
        return raw.toString();
    }

    return "";
};

/** Fetch a bounded count + sample of rows in `table` that reference `rowId`. */
const fetchRelatedRows = async (
    table: string,
    rowId: string,
    readPage: (t: string, search: string) => Promise<TablePage>,
): Promise<{ capNote: string | undefined; rowCount: number; rowIds: string[] }> => {
    try {
        const page = await readPage(table, rowId);
        // One pass: `.map().filter(Boolean)` walked the page twice and, worse, did
        // not narrow away the empty ids — `flatMap` does both.
        const rowIds = page.rows.flatMap((r) => extractRowId(r) || []).slice(0, MAX_ROWS_PER_TABLE);
        // This read runs the COUNT (no `skipCount`), so `total` is present; the
        // `?? 0` only satisfies the now-optional `TablePage.total` type.
        const total = page.total ?? 0;
        const capNote = total > MAX_ROWS_PER_TABLE ? `showing first ${MAX_ROWS_PER_TABLE.toString()} of ${total.toString()}` : undefined;

        return { capNote, rowCount: total, rowIds };
    } catch {
        return { capNote: "count unavailable", rowCount: 0, rowIds: [] };
    }
};

/**
 * Walk the cascade tree and collect data asynchronously. For each related table
 * we issue a bounded count/sample read using the parent row id as a search key.
 * The walk is bounded by MAX_DEPTH and MAX_ROWS_PER_TABLE to keep the preview
 * fast and never run an unbounded query.
 */
const resolveCascadeNode = async (
    table: string,
    rowId: string,
    relation: AdvisorRelation | undefined,
    cascadeMap: Map<string, AdvisorRelation[]>,
    visited: Set<string>,
    depth: number,
    readPage: (t: string, search: string) => Promise<TablePage>,
): Promise<CascadeNode> => {
    // Root node (the row being deleted) vs a related child node.
    const { capNote, rowCount, rowIds } =
        relation === undefined ? { capNote: undefined, rowCount: 1, rowIds: [rowId] } : await fetchRelatedRows(table, rowId, readPage);

    const isRestrict = relation?.onDelete === "restrict";
    const children: CascadeNode[] = [];

    // Stop recursion if already visited (cycle) or at max depth.
    const visitKey = `${table}:${rowId}`;
    const atDepthCap = depth >= MAX_DEPTH;

    if (!visited.has(visitKey) && !atDepthCap) {
        visited.add(visitKey);

        const childRelations = cascadeMap.get(table) ?? [];

        // For each matching row id, collect child impacts (bounded to first 10 sampled ids).
        for (const childRelation of childRelations) {
            for (const id of rowIds.slice(0, 10)) {
                /* eslint-disable no-await-in-loop -- sequential tree walk */
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: the preview walks the relation graph in order, and a parallel burst would hammer one shard for a UI hint
                const child = await resolveCascadeNode(childRelation.table, id, childRelation, cascadeMap, visited, depth + 1, readPage);
                /* eslint-enable no-await-in-loop */

                if (child.rowCount > 0 || depth === 0) {
                    children.push(child);
                }
            }
        }

        visited.delete(visitKey);
    }

    let finalCapNote = capNote;

    if (atDepthCap) {
        const depthCapSuffix = `depth capped at ${MAX_DEPTH.toString()}`;

        finalCapNote = capNote === undefined ? depthCapSuffix : `${capNote}; ${depthCapSuffix}`;
    }

    return { capNote: finalCapNote, children, isRestrict, relation, rowCount, rowIds, table };
};

/**
 * A pre-delete cascade preview dialog. Walks the FK relation graph from the
 * target row, issues bounded read-only queries to estimate how many rows in
 * related tables would be affected (cascade) or would block the delete
 * (restrict), then renders the impact tree before the operator confirms.
 *
 * The walk is bounded by {@link MAX_DEPTH} (tree depth) and
 * {@link MAX_ROWS_PER_TABLE} (rows sampled per table). Caps are surfaced, never
 * silently truncated. Cycles in the FK graph terminate at a second visit to the
 * same (table, row-id) pair.
 */
const CascadePreviewDialog = ({ onClose, onConfirm, readPage, rowId, schema, table }: CascadePreviewProps): ReactElement => {
    const t = useT();

    const [loading, setLoading] = useState<boolean>(true);
    const [rootNode, setRootNode] = useState<CascadeNode | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const run = async (): Promise<void> => {
            try {
                setLoading(true);
                setError(null);

                const cascadeMap = buildCascadeMap(schema);
                const hasRelations = (cascadeMap.get(table) ?? []).length > 0;

                if (!hasRelations) {
                    if (!cancelled) {
                        setRootNode({ capNote: undefined, children: [], isRestrict: false, relation: undefined, rowCount: 1, rowIds: [rowId], table });
                        setLoading(false);
                    }

                    return;
                }

                const node = await resolveCascadeNode(table, rowId, undefined, cascadeMap, new Set<string>(), 0, readPage);

                if (!cancelled) {
                    setRootNode(node);
                    setLoading(false);
                }
            } catch (error_) {
                if (!cancelled) {
                    setError((error_ as Error).message);
                    setLoading(false);
                }
            }
        };

        fireAndForget(run());

        return (): void => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- readPage and schema are stable references passed from parent; rowId and table identify the row being deleted
    }, [rowId, table]);

    const hasBlockers = rootNode !== null && walkCascade(rootNode, (n) => n.isRestrict).length > 0;

    const handleConfirm = (): void => {
        onConfirm();
        onClose();
    };

    return (
        <ModalShell label="Cascade impact preview" onClose={onClose} panelTestId="cascade-panel" testId="cascade-overlay" variant="dialog">
            <div className="flex items-start justify-between">
                <div className="flex flex-col gap-0.5">
                    <h3 className="text-base text-foreground" data-testid="cascade-title">
                        {t("Cascade impact")}
                    </h3>
                    <p className="text-xs text-muted-foreground" data-testid="cascade-desc">
                        {t("Delete preview — rows that would cascade or be blocked")}
                    </p>
                </div>
                <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="cascade-close" onClick={onClose} type="button">
                    {t("Close")}
                </button>
            </div>

            {loading && (
                <p className="text-xs text-muted-foreground" data-testid="cascade-loading">
                    {t("Loading…")}
                </p>
            )}

            {error !== null && (
                <p className="text-xs text-destructive" data-testid="cascade-error" role="alert">
                    {error}
                </p>
            )}

            {!loading && rootNode !== null && (
                <ul className="flex flex-col" data-testid="cascade-tree">
                    <CascadeRow depth={0} node={rootNode} />
                </ul>
            )}

            {!loading && rootNode !== null && rootNode.children.length === 0 && (
                <p className="text-xs text-muted-foreground" data-testid="cascade-no-impact">
                    {t("No related rows found.")}
                </p>
            )}

            {hasBlockers && (
                <p className="text-sm font-medium text-destructive" data-testid="cascade-blocker-warning" role="alert">
                    {t("Restrict relations will block this delete.")}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <button
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    data-testid="cascade-cancel"
                    onClick={onClose}
                    type="button"
                >
                    {t("Cancel")}
                </button>
                <button
                    className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground outline-none transition-colors hover:bg-destructive/90 focus-visible:bg-destructive/90 disabled:pointer-events-none disabled:opacity-50"
                    data-testid="cascade-confirm"
                    disabled={loading}
                    onClick={handleConfirm}
                    type="button"
                >
                    {t("Delete")}
                </button>
            </div>
        </ModalShell>
    );
};

export { CascadePreviewDialog, MAX_DEPTH, MAX_ROWS_PER_TABLE };
export type { CascadeNode, CascadePreviewProps };
