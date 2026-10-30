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
import type { ScheduleOutboxEntry, ScheduleOutboxResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

const DROP_ENTRY = adminRef(ADMIN_FUNCTIONS.dropOutboxEntry);
const REQUEUE_ENTRY = adminRef(ADMIN_FUNCTIONS.retryOutboxEntry);

interface ScheduleOutboxJobsProps {
    /** Shard the view opens on. Outbox rows live per shard, so a sharded app picks one. */
    readonly initialShardKey?: string;
}

const OutboxEmptyState = (): ReactElement => {
    const t = useT();

    return (
        <EmptyState
            description={t("Jobs whose mutation committed but that the scheduler has not accepted yet wait here.")}
            icon={
                <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24">
                    <path d="M4 4h16v12H4zM4 16l4 4h8l4-4" />
                </svg>
            }
            testId="outbox-empty"
            title={t("Nothing is waiting for the scheduler.")}
        />
    );
};

interface OutboxTableProps {
    readonly entries: ReadonlyArray<ScheduleOutboxEntry>;
    readonly onAct: (reference: typeof DROP_ENTRY, id: string) => Promise<void>;
}

const OutboxRow = ({ entry, onAct }: { readonly entry: ScheduleOutboxEntry; readonly onAct: OutboxTableProps["onAct"] }): ReactElement => {
    const t = useT();

    return (
        <TableRow data-testid={`outbox-row-${entry.id}`}>
            <TableCell className="font-mono text-xs">{entry.target ?? t("unreadable")}</TableCell>
            <TableCell>
                <div className="flex gap-1">
                    <Badge variant={entry.parked ? "destructive" : "secondary"}>{entry.parked ? t("parked") : t("retrying")}</Badge>
                    {entry.forever && <Badge variant="outline">{t("forever")}</Badge>}
                </div>
            </TableCell>
            <TableCell className="tabular-nums">{entry.attempts}</TableCell>
            <TableCell className="text-muted-foreground tabular-nums">{entry.parked ? "—" : formatTimestamp(entry.nextAttemptAt, "—")}</TableCell>
            <TableCell className="font-mono text-xs">{entry.id}</TableCell>
            <TableCell className="text-right">
                <div className="flex justify-end gap-1.5">
                    <Button
                        data-testid={`outbox-retry-${entry.id}`}
                        onClick={() => {
                            fireAndForget(onAct(REQUEUE_ENTRY, entry.id));
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
                            fireAndForget(onAct(DROP_ENTRY, entry.id));
                        }}
                        testId={`outbox-drop-${entry.id}`}
                    >
                        {t("Drop")}
                    </ConfirmButton>
                </div>
            </TableCell>
        </TableRow>
    );
};

const OutboxTable = ({ entries, onAct }: OutboxTableProps): ReactElement => {
    const t = useT();

    return (
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
                            <OutboxRow entry={entry} key={entry.id} onAct={onAct} />
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
};

interface OutboxPagerProps {
    readonly cursor: string | undefined;
    readonly nextCursor: string | undefined;
    readonly onFirst: () => void;
    readonly onNext: (cursor: string) => void;
}

const OutboxPager = ({ cursor, nextCursor, onFirst, onNext }: OutboxPagerProps): ReactElement | undefined => {
    const t = useT();

    if (cursor === undefined && nextCursor === undefined) {
        return undefined;
    }

    return (
        <div className="flex justify-end gap-1.5">
            {cursor !== undefined && (
                <Button data-testid="outbox-first-page" onClick={onFirst} size="sm" type="button" variant="outline">
                    {t("First page")}
                </Button>
            )}
            {nextCursor !== undefined && (
                <Button
                    data-testid="outbox-next-page"
                    onClick={() => {
                        onNext(nextCursor);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    {t("Next page")}
                </Button>
            )}
        </div>
    );
};

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

    // A cursor belongs to the shard it was read from. Adjusting state during render drops the
    // stored one the moment the shard changes, so returning to a shard opens on page one.
    const [page, setPage] = useState<{ cursor: string | undefined; shardKey: string }>({ cursor: undefined, shardKey: queryShardKey });

    if (page.shardKey !== queryShardKey) {
        setPage({ cursor: undefined, shardKey: queryShardKey });
    }

    const cursor = page.shardKey === queryShardKey ? page.cursor : undefined;
    // While the debounce settles the input names a shard the rows on screen do not belong to.
    const settling = shardKey.trim() !== queryShardKey;

    const { data, error, poll, refetch } = useAdminQuery<ScheduleOutboxResult>(ADMIN_FUNCTIONS.getScheduleOutbox, cursor === undefined ? {} : { cursor }, {
        shardKey: queryShardKey,
    });
    const entries = settling ? undefined : data?.entries;
    const nextCursor = settling ? undefined : data?.nextCursor;

    const [actionError, setActionError] = useState<string | undefined>(undefined);
    const shownError = error ?? actionError;

    useAutoRefresh(poll, true);

    const act = async (reference: typeof DROP_ENTRY, id: string): Promise<void> => {
        setActionError(undefined);

        try {
            const reply = (await client.query(reference, { id }, callOptions(queryShardKey))) as { retried?: boolean };

            // A drop of an entry that is already gone is what was asked for; a retry is not.
            if (reply.retried === false) {
                setActionError(t("That job is no longer in the outbox."));
            }

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

            {entries?.length === 0 && cursor === undefined && <OutboxEmptyState />}
            {entries !== undefined && entries.length > 0 && <OutboxTable entries={entries} onAct={act} />}

            <OutboxPager
                cursor={cursor}
                nextCursor={nextCursor}
                onFirst={() => {
                    setPage({ cursor: undefined, shardKey: queryShardKey });
                }}
                onNext={(next) => {
                    setPage({ cursor: next, shardKey: queryShardKey });
                }}
            />
        </div>
    );
};

export type { ScheduleOutboxJobsProps };
