import type { ReactElement } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { AdvisoriesResult, MaskColumnMetadata, MaskPoliciesResult, RlsOperation, RlsPoliciesResult, RlsPolicyMetadata } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

/** The four CRUD operations, in read→write order for the matrix columns. */
const OPERATIONS: ReadonlyArray<RlsOperation> = ["read", "insert", "update", "delete"];

/** Localized column header per operation. */
const operationLabel = (t: TFunction, operation: RlsOperation): string =>
    ({ delete: t("Delete"), insert: t("Insert"), read: t("Read"), update: t("Update") })[operation];

/** One table × operation cell: the procedure covering it, if any. */
interface CellState {
    /** Procedure whose `.use(rls(...))` chain declared the covering policy; `undefined` ⇒ no policy. */
    procedure?: string;
}

/** Per-table coverage: the four operation cells, masked columns, and an "uncovered" advisory flag. */
interface TableRowState {
    /** `read|insert|update|delete` → covering procedure (or no policy). */
    cells: Record<RlsOperation, CellState>;
    /** Columns this table masks (from `maskPolicies`). */
    maskedColumns: string[];
    table: string;
    /** True when an `rls_uncovered_table` advisory names this table — reachable without a policy. */
    uncovered: boolean;
}

/** Pull the `rls_uncovered_table` advisory tables out of the advisories payload. */
const uncoveredTables = (advisories: AdvisoriesResult | null): Set<string> => {
    const set = new Set<string>();

    for (const advisory of advisories?.advisories ?? []) {
        if (advisory.name === "rls_uncovered_table") {
            const { table } = advisory.metadata;

            if (typeof table === "string" && table !== "") {
                set.add(table);
            }
        }
    }

    return set;
};

/**
 * Fold the flat policy list, the masked-column list, and the advisory set into
 * one matrix row per table, in alphabetical table order. A table appears when it
 * has a policy, a masked column, or an uncovered advisory.
 */
const buildRows = (policies: RlsPolicyMetadata[], maskColumns: MaskColumnMetadata[], uncovered: Set<string>): TableRowState[] => {
    const byTable = new Map<string, TableRowState>();

    const ensure = (table: string): TableRowState => {
        const existing = byTable.get(table);

        if (existing !== undefined) {
            return existing;
        }

        const row: TableRowState = {
            cells: { delete: {}, insert: {}, read: {}, update: {} },
            maskedColumns: [],
            table,
            uncovered: uncovered.has(table),
        };

        byTable.set(table, row);

        return row;
    };

    for (const policy of policies) {
        ensure(policy.table).cells[policy.on] = { procedure: policy.procedure };
    }

    // Deduped through a Set, not `maskedColumns.includes`: the check is inside the
    // loop, so the array scan made it quadratic in the number of masked columns
    // on one table.
    const seenMasked = new Map<string, Set<string>>();

    for (const column of maskColumns) {
        const row = ensure(column.table);
        const seen = seenMasked.get(column.table) ?? new Set<string>();

        if (!seen.has(column.column)) {
            seen.add(column.column);
            seenMasked.set(column.table, seen);
            row.maskedColumns.push(column.column);
        }
    }

    for (const table of uncovered) {
        ensure(table);
    }

    return [...byTable.values()].toSorted((a, b) => a.table.localeCompare(b.table));
};

interface PermissionsMatrixProps {
    /**
     * Invoked when an operator clicks a covered cell's "Probe this" affordance,
     * prefilled with the cell's table + operation + the covering procedure so the
     * playground can seed the right function. Only covered cells render the link
     * (an uncovered cell has no procedure to probe). Omitted ⇒ no probe links
     * (the matrix is read-only).
     */
    readonly onProbe?: (table: string, operation: RlsOperation, procedure: string) => void;
}

/**
 * The Permissions Matrix — a read-only table × operation grid showing, per
 * table, which `read|insert|update|delete` operation is covered by an RLS policy
 * (and the procedure that declared it), the table's masked columns, and an
 * "uncovered" marker cross-referenced from the `rls_uncovered_table` advisory.
 *
 * It assembles three existing admin RPCs — `rlsPolicies` (live, so it refreshes
 * on every codegen run), `maskPolicies`, and `getAdvisories` — into a single
 * authorization view. Strictly read-only: the `when` predicate is an opaque
 * closure that is never serialized, so this surfaces only the shape of the
 * configuration for auditing.
 */
export const PermissionsMatrix = ({ onProbe }: PermissionsMatrixProps = {}): ReactElement => {
    const t = useT();

    // Live policy channel: each codegen-triggered push refreshes the grid's
    // coverage without a remount. `liveError` holds a rejected-subscription
    // message so the panel can say why it stopped updating; the policies read is
    // the only one that surfaces a hard `error` (masks/advisories are additive).
    const policiesQuery = useAdminQuery<RlsPoliciesResult>(ADMIN_FUNCTIONS.rlsPolicies, {}, { live: true });

    // One-shot reads for the supporting metadata (masks + advisories). These only
    // change on codegen, and a stale read here merely under-/over-flags a cell
    // until the next refetch; their errors are tolerated (treated as empty).
    const masksQuery = useAdminQuery<MaskPoliciesResult>(ADMIN_FUNCTIONS.maskPolicies, {});
    const advisoriesQuery = useAdminQuery<AdvisoriesResult>(ADMIN_FUNCTIONS.getAdvisories, {});

    // `null` while the policies read is in flight; an array once it resolves
    // (coerced to `[]` for a malformed payload), so the matrix knows "not loaded
    // yet" vs "loaded, empty".
    let policies: RlsPolicyMetadata[] | null = null;

    if (policiesQuery.data !== undefined) {
        policies = Array.isArray(policiesQuery.data.policies) ? policiesQuery.data.policies : [];
    }

    const maskColumns: MaskColumnMetadata[] = Array.isArray(masksQuery.data?.columns) ? masksQuery.data.columns : [];
    const advisories: AdvisoriesResult | null = advisoriesQuery.data ?? null;

    // Only a failed policies read blanks the matrix; masks/advisories degrade silently.
    const { error, errorSource, liveError } = policiesQuery;

    const rows = policies === null ? [] : buildRows(policies, maskColumns, uncoveredTables(advisories));

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-permissions-matrix">
            <div className="flex items-center justify-end">
                <LiveError message={liveError} prefix="pm" />
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="pm-error" />}

            {policies !== null && rows.length === 0 ? (
                <EmptyState
                    description={t("Add a `definePolicy` and wire it through `.use(rls(...))` to populate this matrix.")}
                    testId="pm-empty"
                    title={t("No policy")}
                />
            ) : (
                <Table data-testid="pm-table">
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("Table")}</TableHead>
                            {OPERATIONS.map((operation) => (
                                <TableHead key={operation}>{operationLabel(t, operation)}</TableHead>
                            ))}
                            <TableHead>{t("Masked columns")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow data-testid={`pm-row-${row.table}`} key={row.table}>
                                <TableCell className="font-mono text-xs">
                                    <span className="flex items-center gap-1.5">
                                        {row.table}
                                        {row.uncovered && (
                                            <Badge
                                                data-testid={`pm-uncovered-${row.table}`}
                                                title={t("Uncovered — reachable without a policy")}
                                                variant="destructive"
                                            >
                                                {t("Uncovered — reachable without a policy")}
                                            </Badge>
                                        )}
                                    </span>
                                </TableCell>
                                {OPERATIONS.map((operation) => {
                                    const cell = row.cells[operation];

                                    return (
                                        <TableCell data-testid={`pm-cell-${row.table}-${operation}`} key={operation}>
                                            {cell.procedure === undefined ? (
                                                <span className="text-xs text-muted-foreground">{t("No policy")}</span>
                                            ) : (
                                                <span className="flex flex-col gap-1">
                                                    <Badge variant="secondary">{t("Covered by {procedure}", { procedure: cell.procedure })}</Badge>
                                                    {onProbe !== undefined && (
                                                        <Button
                                                            className="h-auto justify-start p-0 text-[11px]"
                                                            data-testid={`pm-probe-${row.table}-${operation}`}
                                                            onClick={() => {
                                                                onProbe(row.table, operation, cell.procedure ?? "");
                                                            }}
                                                            size="xs"
                                                            type="button"
                                                            variant="ghost"
                                                        >
                                                            {t("Probe this")}
                                                        </Button>
                                                    )}
                                                </span>
                                            )}
                                        </TableCell>
                                    );
                                })}
                                <TableCell>
                                    {row.maskedColumns.length === 0 ? (
                                        <span aria-hidden="true" className="text-muted-foreground">
                                            —
                                        </span>
                                    ) : (
                                        <span className="flex flex-wrap gap-1">
                                            {row.maskedColumns.map((column) => (
                                                <Badge key={column} variant="outline">
                                                    {column}
                                                </Badge>
                                            ))}
                                        </span>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </div>
    );
};

export type { PermissionsMatrixProps };
