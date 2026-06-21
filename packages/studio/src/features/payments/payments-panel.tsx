import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import type { TablePage } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface PaymentsPanelProps {
    /** Newest-N rows to load per table (default 100). */
    readonly limit?: number;
}

type Row = Record<string, unknown>;

const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

// Subscription states that count as "active" for the summary + badge tone.
const ACTIVE_STATES = new Set(["active", "trialing"]);
const ALERT_STATES = new Set(["past_due", "unpaid"]);

/**
 * Read a field whether the row exposes it as a column (global/D1 tables) or
 * nested in the shard row's `__doc__` JSON blob — mirrors the data browser.
 */
const readField = (row: Row, key: string): unknown => {
    if (row[key] !== undefined) {
        return row[key];
    }

    const raw = row["__doc__"];

    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw) as unknown;

            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return (parsed as Row)[key];
            }
        } catch {
            // fall through
        }
    }

    return undefined;
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

const readRows = async (client: ReturnType<typeof useLunora>, table: string, limit: number): Promise<Row[]> => {
    const page = (await client.query(READ_TABLE_PAGE, { filters: [], limit, offset: 0, orderBy: [], search: "", table }, callOptions(""))) as TablePage;

    return page.rows;
};

/**
 * Read-only operational view of the `@lunora/payment` sync store: webhook-synced
 * subscriptions (with state) and the recent webhook `events` log. Backed by the
 * generic `readTablePage` admin RPC — payment tables are ordinary app tables, so
 * no payment-specific server endpoint is needed.
 */
const PaymentsPanel = ({ limit = 100 }: PaymentsPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [subscriptions, setSubscriptions] = useState<Row[]>([]);
    const [events, setEvents] = useState<Row[]>([]);
    const [error, setError] = useState<null | string>(null);

    const refresh = async (): Promise<void> => {
        setError(null);

        try {
            const [subscriptionRows, eventRows] = await Promise.all([readRows(client, "subscriptions", limit), readRows(client, "events", 25)]);

            setSubscriptions(subscriptionRows);
            setEvents(eventRows);
        } catch (error_) {
            setSubscriptions([]);
            setEvents([]);
            setError(errorMessage(error_));
        }
    };

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const reload = (): void => {
        fireAndForget(refresh());
    };

    useAutoRefresh(reload, true);

    const activeCount = subscriptions.filter((row) => ACTIVE_STATES.has(text(readField(row, "state")))).length;

    const recentEvents = events.toSorted((a, b) => Number(readField(b, "processedAt") ?? 0) - Number(readField(a, "processedAt") ?? 0));

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

            {error === null ? undefined : <p className="text-sm text-destructive">{error}</p>}

            {subscriptions.length === 0 ? (
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
