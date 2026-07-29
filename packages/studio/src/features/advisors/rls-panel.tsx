import type { ReactElement } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { RlsOperation, RlsPoliciesResult, RlsPolicyMetadata } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

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
    // Procedure names are deduped through a Set, not `procedures.includes`: the
    // check sits inside the fold, so the array scan made it quadratic in the
    // number of policies on one table.
    const seenProcedures = new Map<string, Set<string>>();

    for (const policy of policies) {
        const coverage = byTable.get(policy.table) ?? { operations: new Set<RlsOperation>(), procedures: [], table: policy.table };

        coverage.operations.add(policy.on);

        const seen = seenProcedures.get(policy.table) ?? new Set<string>();

        if (!seen.has(policy.procedure)) {
            seen.add(policy.procedure);
            seenProcedures.set(policy.table, seen);
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
 * discovered by `@lunora/codegen` and served by `__lunora_admin__:rlsPolicies`,
 * so it refreshes on every codegen run (dev: on save; prod: on deploy).
 */
const RlsPanel = (): ReactElement => {
    const t = useT();

    // Deployment-wide metadata (root shard), so no shard selector is needed.
    const { data, error, errorSource } = useAdminQuery<RlsPoliciesResult>(ADMIN_FUNCTIONS.rlsPolicies, {});

    // `undefined` while the first read is in flight — `loaded` distinguishes that
    // from a resolved-but-empty deployment so the empty states only show once the
    // read lands. A non-array policies/roles (older worker / stand-in) is treated
    // as empty rather than throwing.
    const loaded = data !== undefined;
    const tables = groupByTable(Array.isArray(data?.policies) ? data.policies : []);
    const roles = Array.isArray(data?.roles) ? data.roles : [];

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-rls-panel">
            {error !== null && <ErrorAlert error={errorSource} testId="rls-error" />}

            <section className="flex flex-col gap-2">
                <Card className="overflow-hidden py-0">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Policies")}</span>
                    </header>
                    {loaded && tables.length === 0 ? (
                        <EmptyState
                            description={t("No `definePolicy` is wired through `.use(rls(...))` in this deployment. Add one to guard a table's rows.")}
                            testId="rls-policies-empty"
                            title={t("No policies defined")}
                        />
                    ) : (
                        <CardContent className="px-0">
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
                        </CardContent>
                    )}
                </Card>
            </section>

            <section className="flex flex-col gap-2">
                <Card className="overflow-hidden py-0">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Roles")}</span>
                    </header>
                    {loaded && roles.length === 0 ? (
                        <EmptyState
                            description={t("No `defineRole` is registered via `rls(policies, { roles })`. Roles back `ctx.auth.can(...)` permission checks.")}
                            testId="rls-roles-empty"
                            title={t("No roles defined")}
                        />
                    ) : (
                        <CardContent className="px-0">
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
                        </CardContent>
                    )}
                </Card>
            </section>
        </div>
    );
};

export default RlsPanel;
