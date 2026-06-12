import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RlsOperation, RlsPoliciesResult, RlsPolicyMetadata, RlsRoleMetadata } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { EmptyState } from "./components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";

const RLS_POLICIES = adminRef(ADMIN_FUNCTIONS.rlsPolicies);

/** The four CRUD operations a policy can guard, in read→write order for the per-table columns. */
const OPERATIONS: ReadonlyArray<RlsOperation> = ["read", "insert", "update", "delete"];

/** Localized column header per operation. */
const operationLabel = (t: TFunction, operation: RlsOperation): string =>
    ({ delete: t("Delete"), insert: t("Insert"), read: t("Read"), update: t("Update") })[operation];

/** One table's policy coverage: which operations are guarded, and by which procedures. */
interface TableCoverage {
    /** The set of operations a policy guards on this table. */
    operations: Set<RlsOperation>;
    /** Procedures whose `.use(rls(...))` chain declared a policy on this table, deduped. */
    procedures: string[];
    table: string;
}

/** Fold the flat policy list into one row per table, in alphabetical table order. */
const groupByTable = (policies: RlsPolicyMetadata[]): TableCoverage[] => {
    const byTable = new Map<string, TableCoverage>();

    for (const policy of policies) {
        const coverage = byTable.get(policy.table) ?? { operations: new Set<RlsOperation>(), procedures: [], table: policy.table };

        coverage.operations.add(policy.on);

        if (!coverage.procedures.includes(policy.procedure)) {
            coverage.procedures.push(policy.procedure);
        }

        byTable.set(policy.table, coverage);
    }

    return [...byTable.values()].toSorted((a, b) => a.table.localeCompare(b.table));
};

/**
 * The RLS Policy & Role Inspector — a read-only view of the deployment's
 * row-level-security configuration (`definePolicy` / `defineRole` / `rls`). Per
 * table it shows which CRUD operations a policy guards and the procedures that
 * declared them; below, every registered role and the permissions it grants.
 *
 * It is deliberately read-only: RLS lives in code (the `when` predicate is an
 * opaque closure, never serialized), so the inspector surfaces the schema's
 * shape for auditing — DDL-from-UI is a non-goal. The metadata is statically
 * discovered by `@cirrus/codegen` and served by `__cirrus_admin__:rlsPolicies`,
 * so it refreshes on every codegen run (dev: on save; prod: on deploy).
 */
const RlsPanel = (): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [data, setData] = useState<RlsPoliciesResult | null>(null);
    const [error, setError] = useState<null | string>(null);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            // Deployment-wide metadata (root shard), so no shard selector is needed.
            const result = (await client.query(RLS_POLICIES, {}, callOptions(""))) as RlsPoliciesResult;

            // Defensive: an older worker (or a stand-in) may omit either array —
            // treat anything but an array as empty rather than throw.
            setData({
                policies: Array.isArray(result.policies) ? result.policies : [],
                roles: Array.isArray(result.roles) ? result.roles : [],
            });
            setError(null);
        } catch (error_: unknown) {
            setError(errorMessage(error_));
        }
    }, [client]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const tables = useMemo<TableCoverage[]>(() => (data === null ? [] : groupByTable(data.policies)), [data]);
    const roles = useMemo<RlsRoleMetadata[]>(() => data?.roles ?? [], [data]);

    return (
        <div className="flex flex-col gap-6" data-testid="cirrus-rls-panel">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="rls-error" role="alert">
                    {error}
                </p>
            )}

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">{t("Policies")}</h2>
                {data !== null && tables.length === 0 ? (
                    <EmptyState
                        description={t("No `definePolicy` is wired through `.use(rls(...))` in this deployment. Add one to guard a table's rows.")}
                        testId="rls-policies-empty"
                        title={t("No policies defined")}
                    />
                ) : (
                    <Table data-testid="rls-policies-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Table")}</TableHead>
                                {OPERATIONS.map((operation) => (
                                    <TableHead key={operation}>{operationLabel(t, operation)}</TableHead>
                                ))}
                                <TableHead>{t("Guarded by")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {tables.map((coverage) => (
                                <TableRow data-testid={`rls-table-${coverage.table}`} key={coverage.table}>
                                    <TableCell className="font-mono text-xs">{coverage.table}</TableCell>
                                    {OPERATIONS.map((operation) => (
                                        <TableCell key={operation}>
                                            {coverage.operations.has(operation) ? (
                                                <Badge variant="secondary">{t("Guarded")}</Badge>
                                            ) : (
                                                <span aria-hidden="true" className="text-muted-foreground">
                                                    —
                                                </span>
                                            )}
                                        </TableCell>
                                    ))}
                                    <TableCell className="font-mono text-xs text-muted-foreground">{coverage.procedures.join(", ")}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">{t("Roles")}</h2>
                {data !== null && roles.length === 0 ? (
                    <EmptyState
                        description={t("No `defineRole` is registered via `rls(policies, { roles })`. Roles back `ctx.auth.can(...)` permission checks.")}
                        testId="rls-roles-empty"
                        title={t("No roles defined")}
                    />
                ) : (
                    <Table data-testid="rls-roles-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Role")}</TableHead>
                                <TableHead>{t("Description")}</TableHead>
                                <TableHead>{t("Permissions")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {roles.map((role) => (
                                <TableRow data-testid={`rls-role-${role.name}`} key={role.name}>
                                    <TableCell className="font-mono text-xs">{role.name}</TableCell>
                                    <TableCell className="text-muted-foreground">{role.description ?? ""}</TableCell>
                                    <TableCell>
                                        {role.permissions.length === 0 ? (
                                            <span aria-hidden="true" className="text-muted-foreground">
                                                —
                                            </span>
                                        ) : (
                                            <span className="flex flex-wrap gap-1">
                                                {role.permissions.map((permission) => (
                                                    <Badge key={permission} variant="outline">
                                                        {permission}
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
            </section>
        </div>
    );
};

export default RlsPanel;
