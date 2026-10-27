import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { ScheduleOutboxResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

const DROP_ENTRY = adminRef(ADMIN_FUNCTIONS.dropOutboxEntry);
const REQUEUE_ENTRY = adminRef(ADMIN_FUNCTIONS.retryOutboxEntry);

interface ScheduleOutboxJobsProps {
    /** Shard the view opens on. Outbox rows live per shard, so a sharded app picks one. */
    readonly initialShardKey?: string;
}

/**
 * Deferred `ctx.scheduler` jobs a shard still holds: the mutation committed, the
 * hand-off to the scheduler has not landed. They are invisible to the Scheduled
 * jobs view (the SchedulerDO has never seen them) and to `ctx.scheduler.cancel`,
 * so this is where an operator finds them, retries one now, or drops one for
 * good — the only way to stop a `retry.forever` job that is still waiting.
 *
 * The retry loop writes the table without a live push, so this polls on the
 * shared auto-refresh interval and refetches after each action.
 */
export const ScheduleOutboxJobs = ({ initialShardKey }: ScheduleOutboxJobsProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);

    const { data, error, poll, refetch } = useAdminQuery<ScheduleOutboxResult>(ADMIN_FUNCTIONS.getScheduleOutbox, {}, { shardKey: queryShardKey });
    const entries = data?.entries;

    const [actionError, setActionError] = useState<string | undefined>(undefined);
    const shownError = error ?? actionError;

    useAutoRefresh(poll, true);

    const act = async (reference: typeof DROP_ENTRY, id: string): Promise<void> => {
        setActionError(undefined);

        try {
            await client.query(reference, { id }, callOptions(queryShardKey));
            refetch();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-schedule-outbox">
            <ShardInput onChange={setShardKey} testId="outbox-shard-input" value={shardKey} />

            {shownError !== undefined && (
                <p className="text-sm text-destructive" data-testid="outbox-error" role="alert">
                    {shownError}
                </p>
            )}

            {entries?.length === 0 && (
                <EmptyState
                    description={t("Jobs whose mutation committed but that the scheduler has not accepted yet wait here.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 4h16v12H4zM4 16l4 4h8l4-4" />
                        </svg>
                    }
                    testId="outbox-empty"
                    title={t("Nothing is waiting for the scheduler.")}
                />
            )}

            {entries !== undefined && entries.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="outbox-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("state")}</TableHead>
                                    <TableHead>{t("attempts")}</TableHead>
                                    <TableHead>{t("next attempt")}</TableHead>
                                    <TableHead>{t("id")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {entries.map((entry) => (
                                    <TableRow data-testid={`outbox-row-${entry.id}`} key={entry.id}>
                                        <TableCell className="font-mono text-xs">{entry.target ?? t("unreadable")}</TableCell>
                                        <TableCell>
                                            <div className="flex gap-1">
                                                <Badge variant={entry.parked ? "destructive" : "secondary"}>{entry.parked ? t("parked") : t("retrying")}</Badge>
                                                {entry.forever && <Badge variant="outline">{t("forever")}</Badge>}
                                            </div>
                                        </TableCell>
                                        <TableCell className="tabular-nums">{entry.attempts}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">
                                            {entry.parked ? "—" : formatTimestamp(entry.nextAttemptAt, "—")}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">{entry.id}</TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-1.5">
                                                <Button
                                                    data-testid={`outbox-retry-${entry.id}`}
                                                    onClick={() => {
                                                        fireAndForget(act(REQUEUE_ENTRY, entry.id));
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="outline"
                                                >
                                                    {t("Retry now")}
                                                </Button>
                                                <ConfirmButton
                                                    confirmLabel={t("Drop job?")}
                                                    onConfirm={() => {
                                                        fireAndForget(act(DROP_ENTRY, entry.id));
                                                    }}
                                                    testId={`outbox-drop-${entry.id}`}
                                                >
                                                    {t("Drop")}
                                                </ConfirmButton>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { ScheduleOutboxJobsProps };
