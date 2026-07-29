import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, ReactElement } from "react";
import { useMemo, useRef, useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { AuditEntry, AuditLogResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

interface AuditPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

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

/** Estimated height of one virtualized audit row, and the bounded height of the scroll viewport. */
const ROW_HEIGHT = 41;
const SCROLL_HEIGHT = 480;

/** Number of body columns — the colspan a top/bottom spacer row stretches across. */
const COLUMN_COUNT = 5;

/**
 * Viewport-rect observer that floors a zero-height measurement to
 * {@link SCROLL_HEIGHT}. A no-op in a real browser (the scroll container has its
 * CSS height); under jsdom — which reports every box as 0×0 — it hands the
 * virtualizer a real viewport so a bounded, deterministic set of rows mounts in
 * tests instead of zero. Mirrors the logs panel's row virtualization.
 */
const observeViewportRect = (instance: Virtualizer<HTMLDivElement, Element>, callback: (rect: Rect) => void): (() => void) | undefined =>
    observeElementRect(instance, (rect) => {
        callback(rect.height > 0 ? rect : { height: SCROLL_HEIGHT, width: rect.width });
    });

/**
 * Durable audit log for one shard: the admin state-changing operations
 * (`writeRow`, `runMigration`, `importShard`, `applyCdc`) recorded to the
 * reserved `__lunora_audit__` table, newest first. Reads via the
 * `__lunora_admin__:getAuditLog` RPC through `useAdminQuery`; gated by the
 * server's `LUNORA_ADMIN_TOKEN`.
 *
 * Unlike the logs panel (an in-memory ring that resets on hibernation), the
 * audit log is durable and bounded only by a retention cap. The panel is always
 * live: `useAdminQuery`'s `live` subscription re-pushes on every server
 * write-flush so new entries appear without a manual refresh. The op filter is
 * client-side over the already-fetched buffer — it never triggers a refetch.
 */
const AuditPanel = ({ initialShardKey }: AuditPanelProps): ReactElement => {
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [search, setSearch] = useState<string>("");

    // The shard the read targets, debounced so typing a key settles before
    // refetching (and re-subscribing) rather than firing per keystroke.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    // One-shot read + always-on live subscription for the committed shard. `live`
    // streams each server write-flush into the cache so new entries appear without
    // a manual refresh; `liveError` holds a rejection message (e.g. missing admin
    // token) so the panel can say why it stopped updating.
    const { data, error, errorSource, isLoading, liveError } = useAdminQuery<AuditLogResult>(
        ADMIN_FUNCTIONS.getAuditLog,
        {},
        { live: true, shardKey: debouncedShard },
    );

    const entries = useMemo<AuditEntry[]>(() => data?.entries ?? [], [data]);

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

    // Row virtualization over the filtered buffer: only the rows intersecting the
    // bounded viewport (+ overscan) mount, so a durable, retention-capped log never
    // renders hundreds of <tr>s. Spacer rows preserve the real <table> (and its
    // cells) so the semantics, styling, and tests stay intact. See `observeViewportRect`.
    const scrollRef = useRef<HTMLDivElement>(null);

    // react-doctor-disable-next-line react-hooks-js/incompatible-library -- TanStack Virtual returns functions the compiler refuses to memoize; the alternative is not using the library
    const virtualizer = useVirtualizer({
        count: filtered.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 800 },
        observeElementRect: observeViewportRect,
        overscan: 8,
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const paddingTop = virtualRows[0]?.start ?? 0;
    const paddingBottom = totalSize - (virtualRows.at(-1)?.end ?? 0);

    const topSpacerStyle = { height: paddingTop };
    const bottomSpacerStyle = { height: paddingBottom };

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-audit">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="au-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="au" />
                <Input
                    aria-label={t("Filter audit log")}
                    className="h-8 w-48"
                    data-testid="au-search"
                    onChange={onSearchChange}
                    placeholder={t("filter op, table, id")}
                    value={search}
                />
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="au-error" />}

            {error === null && !isLoading && filtered.length === 0 && (
                <EmptyState
                    description={t("State-changing admin operations are recorded here.")}
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
                            <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V3Zm-1 9h8m-8 4h5" />
                        </svg>
                    }
                    testId="au-empty"
                    title={t("No audit entries.")}
                />
            )}

            {filtered.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="max-h-[30rem] overflow-auto px-0" ref={scrollRef}>
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
                                {paddingTop > 0 && (
                                    <tr aria-hidden="true">
                                        {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- presentational virtualization spacer; the row is aria-hidden */}
                                        <td colSpan={COLUMN_COUNT} style={topSpacerStyle} />
                                    </tr>
                                )}
                                {virtualRows.map((virtualRow) => {
                                    const entry = filtered[virtualRow.index] as AuditEntry;
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
                                {paddingBottom > 0 && (
                                    <tr aria-hidden="true">
                                        {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- presentational virtualization spacer; the row is aria-hidden */}
                                        <td colSpan={COLUMN_COUNT} style={bottomSpacerStyle} />
                                    </tr>
                                )}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export { AuditPanel };
export type { AuditPanelProps };
