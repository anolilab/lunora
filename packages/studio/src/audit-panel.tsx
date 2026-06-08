import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuditEntry, AuditLogResult } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { EmptyState } from "./components/ui/empty-state.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import { ShardInput } from "./shard-input.js";
import useLiveAdmin from "./use-live-admin.js";
import { useLiveToggle } from "./use-live-toggle.js";

interface AuditPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_AUDIT_LOG = adminRef(ADMIN_FUNCTIONS.getAuditLog);

/** Longest `detail` JSON rendered inline before it's truncated; the full value stays in the cell `title`. */
const DETAIL_MAX = 80;

/** Serialise an entry's `detail` to a compact, length-bounded string for the table cell. */
const formatDetail = (detail: Record<string, unknown> | undefined): string => {
    if (detail === undefined) {
        return "";
    }

    const json = JSON.stringify(detail);

    return json.length > DETAIL_MAX ? `${json.slice(0, DETAIL_MAX)}…` : json;
};

/**
 * Durable audit log for one shard: the admin state-changing operations
 * (`writeRow`, `runMigration`, `importShard`, `applyCdc`) recorded to the
 * reserved `__cirrus_audit__` table, newest first. Reads via the
 * `__cirrus_admin__:getAuditLog` RPC over the {@link useCirrus} client; gated by
 * the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * Unlike the logs panel (an in-memory ring that resets on hibernation), the
 * audit log is durable and bounded only by a retention cap. An opt-in **Live**
 * toggle opens a subscription that re-pushes on every server write-flush so new
 * entries appear without a manual refresh. The op filter is client-side over the
 * already-fetched buffer — it never triggers a refetch.
 */
const AuditPanel = ({ initialShardKey }: AuditPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    // The shard the live channel keys on — the last one a one-shot committed, so
    // editing the box without refreshing doesn't resubscribe per keystroke.
    const [committedShard, setCommittedShard] = useState<null | string>(null);
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [error, setError] = useState<null | string>(null);
    const [search, setSearch] = useState<string>("");
    const { live, liveError, setLiveError, toggle } = useLiveToggle();

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const result = (await client.query(GET_AUDIT_LOG, {}, callOptions(shard))) as AuditLogResult;

                setCommittedShard(shard);
                setEntries(result.entries);
            } catch (error_) {
                setEntries([]);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    // Live channel: while toggled on, each server push replaces the buffer so
    // new entries appear without a manual refresh.
    useLiveAdmin(
        ADMIN_FUNCTIONS.getAuditLog,
        {},
        committedShard ?? "",
        (result) => {
            setError(null);
            setLiveError(undefined);
            setEntries((result as AuditLogResult).entries);
        },
        live && committedShard !== null,
        setLiveError,
    );

    // Client-side op-substring filter (case-insensitive) over the already-fetched
    // entries, also matching the table/id columns — never triggers a refetch.
    const filtered = useMemo<AuditEntry[]>(() => {
        const needle = search.trim().toLowerCase();

        if (needle === "") {
            return entries;
        }

        return entries.filter(
            (entry) =>
                entry.op.toLowerCase().includes(needle) ||
                (entry.table ?? "").toLowerCase().includes(needle) ||
                (entry.id ?? "").toLowerCase().includes(needle),
        );
    }, [entries, search]);

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const onSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    }, []);

    return (
        <div className="space-y-4" data-testid="cirrus-audit">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="au-shard-input" value={shardKey} />
                <Button data-testid="au-refresh" onClick={refreshCurrent} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="au" />
                <Input
                    aria-label={t("Filter audit log")}
                    className="h-8 w-48"
                    data-testid="au-search"
                    onChange={onSearchChange}
                    placeholder={t("filter op, table, id")}
                    value={search}
                />
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="au-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && filtered.length === 0 && (
                <EmptyState
                    description={t("State-changing admin operations are recorded here.")}
                    icon={
                        <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24">
                            <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V3Zm-1 9h8m-8 4h5" />
                        </svg>
                    }
                    testId="au-empty"
                    title={t("No audit entries.")}
                />
            )}

            {filtered.length > 0 && (
                <Table data-testid="au-table">
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("time")}</TableHead>
                            <TableHead>{t("op")}</TableHead>
                            <TableHead>{t("table")}</TableHead>
                            <TableHead>{t("id")}</TableHead>
                            <TableHead>{t("detail")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filtered.map((entry) => {
                            const detail = formatDetail(entry.detail);

                            return (
                                <TableRow data-testid="au-row" key={entry.seq}>
                                    <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(entry.ts, "—")}</TableCell>
                                    <TableCell>
                                        <Badge variant="secondary">{entry.op}</Badge>
                                    </TableCell>
                                    <TableCell className="font-medium">{entry.table ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                    <TableCell className="max-w-[20ch] truncate font-mono text-xs">
                                        {entry.id ?? <span className="text-muted-foreground">—</span>}
                                    </TableCell>
                                    <TableCell className="max-w-[32ch] truncate font-mono text-xs text-muted-foreground" title={detail || undefined}>
                                        {detail || <span className="text-muted-foreground">—</span>}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            )}
        </div>
    );
};

export { AuditPanel };
export type { AuditPanelProps };
