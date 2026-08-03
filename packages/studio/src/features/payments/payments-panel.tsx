import type { ReactElement } from "react";

// Bundler-inlined shared helper (see CLAUDE.md `shared/` rules).
import { decodeDocument } from "../../../../../shared/wire-codec";
import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import useStudioFeatures from "../../hooks/use-studio-features";
import { useT } from "../../i18n/i18n-context";
import type { TableInfo, TablePage } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

interface PaymentsPanelProps {
    /** Newest-N rows to load per table (default 100). */
    readonly limit?: number;
}

type Row = Record<string, unknown>;

// The `@lunora/payment` store tables this panel reads — used as the runtime
// read-safety guard (a `readTablePage` on a missing table errors).
const PAYMENT_STORE_TABLES = ["subscriptions", "events"] as const;

/** Stable empty args for the no-argument `listTables` presence probe (avoids a fresh object each render). */
const NO_ARGS: Record<string, unknown> = {};

// Subscription states that count as "active" for the summary + badge tone.
const ACTIVE_STATES = new Set(["active", "trialing"]);
const ALERT_STATES = new Set(["past_due", "unpaid"]);

/**
 * Read a field whether the row exposes it as a column (global/D1 tables) or
 * nested in the shard row's `__doc__` JSON blob — mirrors the data browser.
 *
 * Goes through the shared {@link decodeDocument}, so this reader can't disagree
 * with the writer about what a stored value means. No visible change today —
 * the payment schema's only `v.bigint()` columns are on `paymentSessions`, which
 * this panel never reads — but it keeps the surface honest if it ever does.
 */
const readField = (row: Row, key: string): unknown => {
    if (row[key] !== undefined) {
        return row[key];
    }

    const raw = row["__doc__"];

    return typeof raw === "string" ? decodeDocument(raw)?.[key] : undefined;
};

const text = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    return typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" ? String(value) : "";
};

const badgeVariant = (state: string): "default" | "destructive" | "outline" => {
    if (ACTIVE_STATES.has(state)) {
        return "default";
    }

    return ALERT_STATES.has(state) ? "destructive" : "outline";
};

/**
 * Read-only operational view of the `@lunora/payment` sync store: webhook-synced
 * subscriptions (with state) and the recent webhook `events` log. Backed by the
 * generic `readTablePage` admin RPC — payment tables are ordinary app tables, so
 * no payment-specific server endpoint is needed.
 */
const PaymentsPanel = ({ limit = 100 }: PaymentsPanelProps): ReactElement => {
    const t = useT();

    // The codegen `payments` signal — the same real signal (payment store tables
    // declared, matched by shape) the nav gates on. Defaults `true` until the
    // `studioFeatures` RPC resolves (or for a worker predating it), so it never
    // hides a working page.
    const features = useStudioFeatures();

    // Presence probe: the payment store tables only exist when the app hand-declares
    // them in its schema (codegen can't resolve `@lunora/payment`'s cross-package table
    // spread), so a bare `readTablePage` on a missing table errors. Nav gating already
    // hides this page for an app that never declares them, but a worker predating the
    // `studioFeatures` RPC falls back to "show everything" — so gate the reads on the
    // codegen flag AND confirm the tables are actually present, rendering a helpful
    // empty state instead of an "unknown table" alert.
    const { data: tables } = useAdminQuery<TableInfo[]>(ADMIN_FUNCTIONS.listTables, NO_ARGS, { live: true });

    const loadedTables = tables !== undefined;
    const tablesPresent = Array.isArray(tables) && PAYMENT_STORE_TABLES.every((name) => tables.some((table) => table.name === name));
    const hasPaymentTables = features.payments && tablesPresent;

    // Payment tables are ordinary app tables, read through the generic
    // `readTablePage` RPC (no payment-specific endpoint). The structural query
    // key dedupes the inline args, so a fresh object each render is harmless.
    const subscriptionsQuery = useAdminQuery<TablePage>(
        ADMIN_FUNCTIONS.readTablePage,
        {
            filters: [],
            limit,
            offset: 0,
            orderBy: [],
            search: "",
            table: "subscriptions",
        },
        { enabled: hasPaymentTables },
    );
    const eventsQuery = useAdminQuery<TablePage>(
        ADMIN_FUNCTIONS.readTablePage,
        {
            filters: [],
            limit: 25,
            offset: 0,
            orderBy: [],
            search: "",
            table: "events",
        },
        { enabled: hasPaymentTables },
    );

    // The payment sync store has no client-observable write event to push on, so
    // poll (skipped while the tab is hidden by `useAutoRefresh`). Skip the poll when
    // the tables are absent — `refetch()` fires regardless of `enabled`, and a poll
    // against a missing table would resurrect the "unknown table" error.
    useAutoRefresh(() => {
        if (!hasPaymentTables) {
            return;
        }

        subscriptionsQuery.refetch();
        eventsQuery.refetch();
    }, true);

    const subscriptions = subscriptionsQuery.data?.rows ?? [];
    const events = eventsQuery.data?.rows ?? [];
    const error = subscriptionsQuery.error ?? eventsQuery.error;
    const errorSource = subscriptionsQuery.error === null ? eventsQuery.errorSource : subscriptionsQuery.errorSource;

    const activeCount = subscriptions.filter((row) => ACTIVE_STATES.has(text(readField(row, "state")))).length;

    const recentEvents = events.toSorted((a, b) => Number(readField(b, "processedAt") ?? 0) - Number(readField(a, "processedAt") ?? 0));

    // The app pulls in `@lunora/payment` (or an old worker shows every page) but never
    // declared the store tables — guide the user rather than surfacing a table error.
    if (loadedTables && !hasPaymentTables) {
        return (
            <div className="flex flex-col gap-4" data-testid="payments-panel">
                <EmptyState
                    description={t(
                        "No @lunora/payment tables found in this deployment. Declare the store tables (subscriptions, events, …) in lunora/schema.ts and wire `payment` on createShardDO() to sync customers and subscriptions.",
                    )}
                    testId="payments-unconfigured"
                    title={t("No payments configured")}
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="payments-panel">
            <div className="flex items-center gap-2" data-testid="payments-summary">
                <Card className="justify-between gap-0 py-0">
                    <div className="flex flex-col gap-2.5 p-4">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Subscriptions")}</span>
                        <div className="flex items-center gap-2">
                            <span className="text-2xl font-semibold tabular-nums text-foreground">{activeCount}</span>
                            <Badge variant="default">{t("{count} active", { count: activeCount })}</Badge>
                        </div>
                    </div>
                    <div className="border-t border-border bg-muted/50 px-4 py-2.5 text-[11px] text-muted-foreground">
                        {t("{total} total", { total: subscriptions.length })}
                    </div>
                </Card>
            </div>

            {error === null ? undefined : <ErrorAlert error={errorSource} />}

            {subscriptions.length === 0 && !subscriptionsQuery.isLoading ? (
                <EmptyState testId="payments-empty" title={t("No subscriptions yet")} />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Provider")}</TableHead>
                                    <TableHead>{t("Reference")}</TableHead>
                                    <TableHead>{t("Plan")}</TableHead>
                                    <TableHead>{t("State")}</TableHead>
                                    <TableHead>{t("Renews")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {subscriptions.map((row) => {
                                    const state = text(readField(row, "state"));

                                    return (
                                        <TableRow data-testid="payment-subscription-row" key={text(readField(row, "providerSubscriptionId"))}>
                                            <TableCell>{text(readField(row, "provider"))}</TableCell>
                                            <TableCell>{text(readField(row, "referenceId"))}</TableCell>
                                            <TableCell>{text(readField(row, "priceId"))}</TableCell>
                                            <TableCell>
                                                <Badge variant={badgeVariant(state)}>{state}</Badge>
                                            </TableCell>
                                            <TableCell>{formatTimestamp(readField(row, "currentPeriodEnd") as null | number | undefined)}</TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            <Card className="overflow-hidden py-0">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Recent webhook events")}</span>
                </header>
                <CardContent className="px-0">
                    <Table>
                        <TableBody>
                            {recentEvents.map((row) => (
                                <TableRow data-testid="payment-event-row" key={text(readField(row, "providerEventId"))}>
                                    <TableCell>{text(readField(row, "provider"))}</TableCell>
                                    <TableCell className="font-medium">{text(readField(row, "type"))}</TableCell>
                                    <TableCell className="text-muted-foreground">{text(readField(row, "providerEventId"))}</TableCell>
                                    <TableCell>{formatTimestamp(readField(row, "processedAt") as null | number | undefined)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export { PaymentsPanel };
export type { PaymentsPanelProps };
