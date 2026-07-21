import type { PipelineLogCursor, PipelineLogQuery, PipelineLogRow } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { LOG_LEVEL_ORDER } from "../../../../../shared/log-event";
import { formatLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_OBSERVABILITY_URL } from "../../lib/cf-links";
import { errorCode, errorMessage, fireAndForget } from "../../lib/internal";

/** The error code the server returns when the operator has wired no archive table / R2 SQL creds. */
const NOT_CONFIGURED_CODE = "LOG_ARCHIVE_NOT_CONFIGURED";

/** A Badge variant per severity — mirrors the Logs panel's `LEVEL_VARIANT`. */
const LEVEL_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
    debug: "secondary",
    error: "destructive",
    fatal: "destructive",
    info: "outline",
    log: "outline",
    trace: "outline",
    warn: "secondary",
};

interface ArchiveFeedProps {
    /** The shard to scope the archive read to (empty = the root shard). Threaded from the Logs panel's shard input. */
    readonly shardKey: string;
}

/** One archive row: time · level · path · message (+ fields) · trace · shard · user. */
const ArchiveRow = ({ row }: { readonly row: PipelineLogRow }): ReactElement => {
    const fields = formatLogFields(row.fields);

    return (
        <TableRow data-testid={`lg-archive-row-${String(row.ts)}`}>
            <TableCell className="tabular-nums whitespace-nowrap text-xs text-muted-foreground">{new Date(row.ts).toLocaleString()}</TableCell>
            <TableCell>
                <Badge variant={LEVEL_VARIANT[row.level] ?? "outline"}>{row.level}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.functionPath}</TableCell>
            <TableCell className="max-w-md">
                <div className="truncate" title={row.message}>
                    {row.message}
                </div>
                {fields !== "" && (
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={fields}>
                        {fields}
                    </div>
                )}
            </TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.traceId ?? "—"}</TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.shardKey ?? "—"}</TableCell>
            <TableCell className="font-mono text-[11px] text-muted-foreground">{row.userId ?? "—"}</TableCell>
        </TableRow>
    );
};

/**
 * The Logs panel's **Archive** feed: the durable `ctx.log` archive that
 * `pipelineLogSink` writes to R2 (an Iceberg table in R2 Data Catalog), read back
 * via the admin-gated `/_lunora/admin/logs/archive` route (the server holds the
 * R2 SQL credentials and runs the reader — the browser only sees decoded rows).
 *
 * Unlike the Requests/Errors feeds (bounded in-DO reads over a live WS), this is
 * an HTTP-only, keyset-paginated read with no live updates: it fetches one page,
 * and "Load more" appends the next (`nextCursor`). When the operator has wired no
 * archive (no table / no R2 SQL creds), the server returns
 * `LOG_ARCHIVE_NOT_CONFIGURED`, which renders as a "not configured" empty state
 * rather than an error.
 */
export const ArchiveFeed = ({ shardKey }: ArchiveFeedProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [pathPrefix, setPathPrefix] = useState<string>("");
    const [userIdFilter, setUserIdFilter] = useState<string>("");
    const [minLevel, setMinLevel] = useState<string>("");

    const [rows, setRows] = useState<null | PipelineLogRow[]>(null);
    const [cursor, setCursor] = useState<PipelineLogCursor | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);
    const [notConfigured, setNotConfigured] = useState<boolean>(false);

    const debouncedPathPrefix = useDebounced(pathPrefix.trim(), 400);
    const debouncedUserId = useDebounced(userIdFilter.trim(), 400);

    // The base filter (excluding the paging cursor). Built fresh each render; the
    // effect below keys off its serialization so an equal filter doesn't refetch.
    const baseQuery: PipelineLogQuery = {
        ...(debouncedPathPrefix === "" ? {} : { functionPathPrefix: debouncedPathPrefix }),
        ...(minLevel === "" ? {} : { minLevel: minLevel as PipelineLogQuery["minLevel"] }),
        ...(shardKey === "" ? {} : { shardKey }),
        ...(debouncedUserId === "" ? {} : { userId: debouncedUserId }),
    };
    const querySignature = JSON.stringify(baseQuery);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                setLoading(true);

                try {
                    const page = await client.queryLogArchive(JSON.parse(querySignature) as PipelineLogQuery);

                    if (!token.cancelled) {
                        setRows(page.rows);
                        setCursor(page.nextCursor);
                        setError(null);
                        setNotConfigured(false);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setRows(null);
                        setCursor(undefined);

                        // A "not configured" failure is an empty state, not an error spew.
                        if (errorCode(error_) === NOT_CONFIGURED_CODE) {
                            setNotConfigured(true);
                            setError(null);
                        } else {
                            setNotConfigured(false);
                            setError(errorMessage(error_));
                        }
                    }
                } finally {
                    if (!token.cancelled) {
                        setLoading(false);
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, querySignature]);

    const loadMore = async (): Promise<void> => {
        if (cursor === undefined) {
            return;
        }

        setLoading(true);

        try {
            const page = await client.queryLogArchive({ ...baseQuery, cursor });

            setRows((current) => [...(current ?? []), ...page.rows]);
            setCursor(page.nextCursor);
            setError(null);
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setLoading(false);
        }
    };

    const onPathPrefixChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setPathPrefix(event.target.value);
    };

    const onUserIdChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setUserIdFilter(event.target.value);
    };

    const onMinLevelChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        setMinLevel(event.target.value);
    };

    const onLoadMore = (): void => {
        fireAndForget(loadMore());
    };

    if (notConfigured) {
        return (
            <EmptyState
                action={
                    <a className="text-sm text-primary underline-offset-4 hover:underline" href={CLOUDFLARE_OBSERVABILITY_URL} rel="noreferrer" target="_blank">
                        {t("Open in Cloudflare")}
                    </a>
                }
                description={t(
                    "Wire pipelineLogSink to a Cloudflare Pipeline → R2 Data Catalog table and set R2_SQL_ACCOUNT_ID, R2_SQL_TOKEN, R2_SQL_BUCKET to browse the durable log archive here.",
                )}
                testId="lg-archive-not-configured"
                title={t("Log archive not configured")}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4" data-testid="lg-archive">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Function path prefix")}
                    className="h-8 w-48"
                    data-testid="lg-archive-path"
                    onChange={onPathPrefixChange}
                    placeholder={t("function path…")}
                    value={pathPrefix}
                />
                <Input
                    aria-label={t("User id")}
                    className="h-8 w-40"
                    data-testid="lg-archive-user"
                    onChange={onUserIdChange}
                    placeholder={t("user id…")}
                    value={userIdFilter}
                />
                <select
                    aria-label={t("Minimum level")}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                    data-testid="lg-archive-min-level"
                    onChange={onMinLevelChange}
                    value={minLevel}
                >
                    <option value="">{t("min level")}</option>
                    {LOG_LEVEL_ORDER.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="lg-archive-error" role="alert">
                    {error}
                </p>
            )}

            {rows !== null && rows.length === 0 && (
                <EmptyState
                    description={t("No archived logs match these filters. The durable archive fills as pipelineLogSink flushes records to R2.")}
                    testId="lg-archive-empty"
                    title={t("No archived logs.")}
                />
            )}

            {rows !== null && rows.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-border shadow-xs">
                    <Table data-testid="lg-archive-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Time")}</TableHead>
                                <TableHead>{t("Level")}</TableHead>
                                <TableHead>{t("Function")}</TableHead>
                                <TableHead>{t("Message")}</TableHead>
                                <TableHead>{t("Trace")}</TableHead>
                                <TableHead>{t("Shard")}</TableHead>
                                <TableHead>{t("User")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, index) => (
                                <ArchiveRow key={`${String(row.ts)}-${String(index)}`} row={row} />
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {cursor !== undefined && (
                <div>
                    <Button data-testid="lg-archive-more" disabled={loading} onClick={onLoadMore} size="sm" variant="outline">
                        {loading ? t("Loading…") : t("Load more")}
                    </Button>
                </div>
            )}
        </div>
    );
};

export type { ArchiveFeedProps };
