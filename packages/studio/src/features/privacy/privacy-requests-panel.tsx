import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useId } from "react";

import type { RequestStatus } from "../../../../../shared/privacy-request-status";
import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { formatTimestamp } from "../../lib/internal";
import { cn } from "../../lib/utils";
import type { PrivacyRequestRow, PrivacyRequestsSource } from "./privacy-requests-source";
import { isPrivacyRequestOverdue } from "./privacy-requests-source";

/** Query key shared by the list read and the invalidation after a retry. */
const QUERY_KEY = ["studio", "privacy-requests"] as const;

/** The rows plus the clock read when they were fetched, so overdue is pure at render. */
interface PrivacySnapshot {
    readonly asOf: number;
    readonly requests: ReadonlyArray<PrivacyRequestRow>;
}

interface PrivacyRequestsPanelProps {
    /** The host app's data source. Without it the page renders a "not configured" state. */
    readonly source?: PrivacyRequestsSource;
}

type StatusBadgeVariant = "destructive" | "info" | "outline" | "secondary" | "success" | "warning";

/**
 * Badge variant per status. Exhaustive over {@link RequestStatus}: a status
 * added to the union without a variant here fails to compile. A failed request is
 * the one an operator must act on, so it is the only destructive badge.
 */
const STATUS_VARIANT: Readonly<Record<RequestStatus, StatusBadgeVariant>> = {
    cancelled: "outline",
    completed: "success",
    expired: "outline",
    failed: "destructive",
    grace: "secondary",
    processing: "warning",
    ready: "success",
    received: "info",
};

/** Human-readable deadline cell: the extended date when one is set, otherwise a dash. */
const formatOptionalTimestamp = (value: null | number | undefined): string => formatTimestamp(value ?? undefined, "—");

interface PrivacyRequestRowViewProps {
    readonly asOf: number;
    readonly onRetry: (id: string) => void;
    readonly retrying: boolean;
    readonly row: PrivacyRequestRow;
}

const PrivacyRequestRowView = ({ asOf, retrying, row, onRetry }: PrivacyRequestRowViewProps): ReactElement => {
    const t = useT();
    const overdue = isPrivacyRequestOverdue(row, asOf);

    return (
        <TableRow className={cn(overdue && "bg-destructive/5")} data-overdue={overdue ? "true" : "false"} data-testid="privacy-request-row">
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell>
                <Badge variant="secondary">{row.type === "export" ? t("Export") : t("Erasure")}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.subjectId}</TableCell>
            <TableCell>
                <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
            </TableCell>
            <TableCell>{formatTimestamp(row.receivedAt)}</TableCell>
            <TableCell>{formatTimestamp(row.dueAt)}</TableCell>
            <TableCell>{formatOptionalTimestamp(row.extendedDueAt)}</TableCell>
            <TableCell>
                {overdue && (
                    <Badge data-testid="privacy-overdue" variant="destructive">
                        {t("Overdue")}
                    </Badge>
                )}
            </TableCell>
            <TableCell>
                {row.status === "failed" && (
                    <Button
                        disabled={retrying}
                        onClick={() => {
                            onRetry(row.id);
                        }}
                        size="xs"
                        variant="outline"
                    >
                        {t("Retry")}
                    </Button>
                )}
            </TableCell>
        </TableRow>
    );
};

interface PrivacyRequestsViewProps {
    readonly source: PrivacyRequestsSource;
}

/** The connected view: reads the list, runs retries, and renders each state. */
const PrivacyRequestsView = ({ source }: PrivacyRequestsViewProps): ReactElement => {
    const t = useT();
    const queryClient = useQueryClient();
    // One cache entry per mounted panel, so two panels under one QueryClient never show each other's rows.
    const queryKey = [...QUERY_KEY, useId()] as const;

    const list = useQuery<PrivacySnapshot>({
        queryKey,
        // Refetch so `asOf` moves on and a deadline that passes while the page is open shows as overdue.
        refetchInterval: 60_000,
        queryFn: async () => {
            return { asOf: Date.now(), requests: await source.listOpenPrivacyRequests() };
        },
        // The app's QueryClient defaults to an infinite staleTime; an operator page
        // must refetch on every visit so a request closed elsewhere does not linger.
        staleTime: 0,
    });

    const retry = useMutation({
        mutationFn: (id: string) => source.retryPrivacyRequest(id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey });
        },
    });

    const onRetry = (id: string): void => {
        retry.mutate(id);
    };

    if (list.isPending) {
        return (
            <p className="text-sm text-muted-foreground" data-testid="privacy-requests-loading" role="status">
                {t("Loading privacy requests…")}
            </p>
        );
    }

    if (list.isError) {
        return <ErrorAlert error={list.error} testId="privacy-requests-error" />;
    }

    const { asOf, requests } = list.data;

    if (requests.length === 0) {
        return <EmptyState testId="privacy-requests-empty" title={t("No open privacy requests.")} />;
    }

    return (
        <div className="flex flex-col gap-3">
            {retry.isError && <ErrorAlert error={retry.error} testId="privacy-retry-error" />}
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t("ID")}</TableHead>
                        <TableHead>{t("Type")}</TableHead>
                        <TableHead>{t("Subject")}</TableHead>
                        <TableHead>{t("Status")}</TableHead>
                        <TableHead>{t("Received")}</TableHead>
                        <TableHead>{t("Due")}</TableHead>
                        <TableHead>{t("Extended due")}</TableHead>
                        <TableHead>{t("Overdue")}</TableHead>
                        <TableHead>{t("Actions")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {requests.map((row) => (
                        <PrivacyRequestRowView asOf={asOf} key={row.id} onRetry={onRetry} retrying={retry.isPending && retry.variables === row.id} row={row} />
                    ))}
                </TableBody>
            </Table>
        </div>
    );
};

/**
 * The Privacy requests page. Lists the app's open data-subject requests and lets
 * an operator retry a failed one. It holds no client of its own: every read and
 * write goes through `source`. With no source it renders a "not configured" state.
 */
const PrivacyRequestsPanel = ({ source }: PrivacyRequestsPanelProps = {}): ReactElement => {
    const t = useT();

    if (source === undefined) {
        return (
            <EmptyState
                description={t("Pass privacyRequests to the Studio to list and retry data-subject requests.")}
                testId="privacy-requests-not-configured"
                title={t("Privacy requests not configured")}
            />
        );
    }

    return <PrivacyRequestsView source={source} />;
};

export type { PrivacyRequestsPanelProps };
export { PrivacyRequestsPanel };
