import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
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

    const refresh = useCallback(async (): Promise<void> => {
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
    }, [client, limit]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const reload = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    useAutoRefresh(reload, true);

    const activeCount = useMemo(() => subscriptions.filter((row) => ACTIVE_STATES.has(text(readField(row, "state")))).length, [subscriptions]);

    const recentEvents = useMemo(
        () => events.toSorted((a, b) => Number(readField(b, "processedAt") ?? 0) - Number(readField(a, "processedAt") ?? 0)),
        [events],
    );

    return (
        <div className="flex flex-col gap-4" data-testid="payments-panel">
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="payments-summary">
                <span>{t("Subscriptions")}</span>
                <Badge variant="default">{t("{count} active", { count: activeCount })}</Badge>
                <span>·</span>
                <span>{t("{total} total", { total: subscriptions.length })}</span>
            </div>

            {error === null ? undefined : <p className="text-sm text-destructive">{error}</p>}

            {subscriptions.length === 0 ? (
                <EmptyState testId="payments-empty" title={t("No subscriptions yet")} />
            ) : (
                <ScrollArea className="rounded-md border">
                    <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground">
                            <tr>
                                <th className="p-2">{t("Provider")}</th>
                                <th className="p-2">{t("Reference")}</th>
                                <th className="p-2">{t("Plan")}</th>
                                <th className="p-2">{t("State")}</th>
                                <th className="p-2">{t("Renews")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {subscriptions.map((row) => {
                                const state = text(readField(row, "state"));

                                return (
                                    <tr className="border-t" data-testid="payment-subscription-row" key={text(readField(row, "providerSubscriptionId"))}>
                                        <td className="p-2">{text(readField(row, "provider"))}</td>
                                        <td className="p-2">{text(readField(row, "referenceId"))}</td>
                                        <td className="p-2">{text(readField(row, "priceId"))}</td>
                                        <td className="p-2">
                                            <Badge variant={badgeVariant(state)}>{state}</Badge>
                                        </td>
                                        <td className="p-2">{formatTimestamp(readField(row, "currentPeriodEnd") as null | number | undefined)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </ScrollArea>
            )}

            <Separator />

            <div className="text-sm text-muted-foreground">{t("Recent webhook events")}</div>
            <ScrollArea className="rounded-md border">
                <table className="w-full text-sm">
                    <tbody>
                        {recentEvents.map((row) => (
                            <tr className="border-t" data-testid="payment-event-row" key={text(readField(row, "providerEventId"))}>
                                <td className="p-2">{text(readField(row, "provider"))}</td>
                                <td className="p-2 font-medium">{text(readField(row, "type"))}</td>
                                <td className="p-2 text-muted-foreground">{text(readField(row, "providerEventId"))}</td>
                                <td className="p-2">{formatTimestamp(readField(row, "processedAt") as null | number | undefined)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </ScrollArea>
        </div>
    );
};

export { PaymentsPanel };
export type { PaymentsPanelProps };
