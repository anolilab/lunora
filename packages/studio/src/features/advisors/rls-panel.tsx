import type { ReactElement } from "react";

import { useAssistant } from "../../components/assistant-provider";
import ErrorAlert from "../../components/error-alert";
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

/**
 * Tables summarised into the seeded question.
 *
 * The whole point of seeding is to save the assistant a `readPolicies` round, so
 * the summary has to fit a turn rather than be the table again. Past this the
 * question says how many were left out and the assistant reads the rest itself —
 * which is the same data through the same op, just one round later.
 */
const MAX_SUMMARISED_TABLES = 30;

/** Localized column header per operation. */
const operationLabel = (t: TFunction, operation: RlsOperation): string =>
    ({ delete: t("Delete"), insert: t("Insert"), read: t("Read"), update: t("Update") })[operation];

/** One table's policy coverage: which operations are guarded, and by which procedures. */
interface TableCoverage {
    /** The set of operations a policy guards on this table. */
    operations: Set<RlsOperation>;
    /** Procedures whose `.use(rls(...))` chain declared a policy on this table. A Set, like `operations` — dedup is the point. */
    procedures: Set<string>;
    table: string;
}

/** Fold the flat policy list into one row per table, in alphabetical table order. */
const groupByTable = (policies: RlsPolicyMetadata[]): TableCoverage[] => {
    const byTable = new Map<string, TableCoverage>();

    for (const policy of policies) {
        const coverage = byTable.get(policy.table) ?? { operations: new Set<RlsOperation>(), procedures: new Set<string>(), table: policy.table };

        coverage.operations.add(policy.on);

        coverage.procedures.add(policy.procedure);

        byTable.set(policy.table, coverage);
    }

    return [...byTable.values()].toSorted((a, b) => a.table.localeCompare(b.table));
};

/**
 * The coverage on screen, as one line the assistant can read.
 *
 * Passed VERBATIM for the same reason an advisor finding is: this is exactly what
 * the operator is looking at, and making the model re-derive it from a tool would
 * spend a round of the per-turn budget re-reading what the panel already has.
 */
const coverageSummary = (tables: ReadonlyArray<TableCoverage>): string => {
    const shown = tables
        .slice(0, MAX_SUMMARISED_TABLES)
        .map((coverage) => `${coverage.table}: ${OPERATIONS.filter((operation) => coverage.operations.has(operation)).join("/")}`)
        .join("; ");

    return tables.length > MAX_SUMMARISED_TABLES ? `${shown}; and ${String(tables.length - MAX_SUMMARISED_TABLES)} more tables` : shown;
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
 *
 * "Ask the assistant" does not change that. It opens the shell-wide assistant on
 * the coverage shown here; the answer is prose containing proposed TypeScript,
 * and applying it is still the operator's job — by hand, or through the
 * scaffolder on the Permissions page, which is the only thing in the Studio that
 * can write a policy file and is reachable only on a loopback dev host.
 */
const RlsPanel = (): ReactElement => {
    const t = useT();

    // `undefined` when no provider is mounted (a bare-composed Studio panel), and
    // `unavailable` once the deployment has reported it cannot run a turn. Either
    // way the control is not rendered rather than rendered dead — the contract
    // `useAssistant`'s docblock states.
    const assistant = useAssistant();
    const canAsk = assistant !== undefined && !assistant.unavailable;

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
                    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Policies")}</span>
                        {/* Only once the read has LANDED. The seed is built from the
                            coverage on screen, and while the query is in flight that is
                            an empty table — clicking early asked "you have no policies
                            at all" about a deployment that has plenty. */}
                        {loaded && canAsk && (
                            <button
                                className="ms-auto text-xs underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                data-testid="rls-ask-assistant"
                                onClick={() => {
                                    /*
                                     * A PROPOSAL, not an edit. There is no policy DDL to
                                     * generate and no admin op that could apply one: a policy
                                     * is TypeScript under `lunora/`, written by the loopback
                                     * dev-host scaffolder on the Permissions page. So the
                                     * assistant answers with source the operator reads, copies
                                     * and applies there — the same "insert, never execute"
                                     * boundary the SQL console holds, with the scaffolder
                                     * standing in for the editor.
                                     */
                                    assistant.openAssistant({
                                        ask:
                                            tables.length === 0
                                                ? t(
                                                      "This app declares no row-level-security policies at all. Which tables most need one, and what policy should I write for them?",
                                                  )
                                                : t(
                                                      "The Lunora RLS inspector shows these declared policies — {coverage}. Which tables and operations are still unguarded, and what policy should I add?",
                                                      { coverage: coverageSummary(tables) },
                                                  ),
                                        suggestions: [t("Which procedures still need .use(rls(...))?"), t("How do I test a policy?")],
                                        title: t("Access rules"),
                                    });
                                }}
                                type="button"
                            >
                                {t("Ask the assistant")}
                            </button>
                        )}
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
                                            <TableCell className="font-mono text-xs text-muted-foreground">{[...coverage.procedures].join(", ")}</TableCell>
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
