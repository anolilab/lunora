import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { PitrBookmarkResult, PitrRestoreResult } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { ConfirmButton } from "./confirm-button.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal.js";

interface PitrPanelProps {
    /** Shard key the PITR ops target. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_BOOKMARK = adminRef(ADMIN_FUNCTIONS.getPitrBookmark);
const PITR_RESTORE = adminRef(ADMIN_FUNCTIONS.pitrRestore);

/**
 * Native Durable-Object point-in-time recovery for one shard — the **Time
 * Travel** view.
 *
 * Reads the shard's current bookmark, previews the bookmark nearest a chosen
 * time, and (behind a confirm step) restores the shard to a time or an explicit
 * bookmark via the `__cirrus_admin__:pitrRestore` RPC, surfacing the returned
 * undo bookmark so the restore can be reversed. All ops run over the
 * {@link useCirrus} client and are gated by the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * In-place recovery covers the last 30 days; for older or off-platform recovery
 * use the snapshot tier (`cirrus backup` / the backup registry item).
 */
export const PitrPanel = ({ initialShardKey }: PitrPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();
    const shardKey = initialShardKey ?? "";

    const [current, setCurrent] = useState<null | string>(null);
    const [time, setTime] = useState<string>("");
    const [preview, setPreview] = useState<null | string>(null);
    const [bookmark, setBookmark] = useState<string>("");
    const [restart, setRestart] = useState<boolean>(false);
    const [restored, setRestored] = useState<null | PitrRestoreResult>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);

    const refresh = useCallback(async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            const result = (await client.query(GET_BOOKMARK, {}, callOptions(shardKey))) as PitrBookmarkResult;

            setCurrent(result.current);
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [client, shardKey]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    const onTimeChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setTime(event.target.value);
    }, []);

    const onBookmarkChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setBookmark(event.target.value);
    }, []);

    const onRestartChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setRestart(event.target.checked);
    }, []);

    const onPreview = useCallback((): void => {
        if (time.trim() === "") {
            return;
        }

        fireAndForget(
            (async (): Promise<void> => {
                setBusy(true);
                setError(null);

                try {
                    const result = (await client.query(GET_BOOKMARK, { time: time.trim() }, callOptions(shardKey))) as PitrBookmarkResult;

                    setPreview(result.forTime ?? null);
                    setCurrent(result.current);
                } catch (error_) {
                    setPreview(null);
                    setError(errorMessage(error_));
                } finally {
                    setBusy(false);
                }
            })(),
        );
    }, [client, shardKey, time]);

    const runRestore = useCallback(
        (args: { bookmark?: string; restart?: boolean; time?: string }): void => {
            fireAndForget(
                (async (): Promise<void> => {
                    setBusy(true);
                    setError(null);

                    try {
                        const result = (await client.mutation(PITR_RESTORE, args, callOptions(shardKey))) as PitrRestoreResult;

                        setRestored(result);
                        await refresh();
                    } catch (error_) {
                        setError(errorMessage(error_));
                    } finally {
                        setBusy(false);
                    }
                })(),
            );
        },
        [client, refresh, shardKey],
    );

    // A restore needs an explicit bookmark or a time to aim at.
    const canRestore = bookmark.trim() !== "" || time.trim() !== "";

    const onConfirmRestore = useCallback((): void => {
        const args: { bookmark?: string; restart?: boolean; time?: string } = restart ? { restart: true } : {};

        if (bookmark.trim() === "") {
            args.time = time.trim();
        } else {
            args.bookmark = bookmark.trim();
        }

        runRestore(args);
    }, [bookmark, restart, runRestore, time]);

    const onUndo = useCallback((): void => {
        if (restored === null) {
            return;
        }

        runRestore(restart ? { bookmark: restored.undoBookmark, restart: true } : { bookmark: restored.undoBookmark });
    }, [restart, restored, runRestore]);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-pitr">
            <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="pitr-refresh" disabled={busy} onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <span className="text-xs text-muted-foreground">
                    {t("Shard")}: <span className="font-mono">{shardKey === "" ? t("root") : shardKey}</span>
                </span>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="pitr-note">
                {t("In-place recovery to any moment in the last 30 days. For older or portable recovery, use the snapshot backup tier.")}
            </p>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="pitr-error" role="alert">
                    {error}
                </p>
            )}

            <section className="rounded-md border border-border p-3">
                <h3 className="mb-2 text-sm font-semibold">{t("Current bookmark")}</h3>
                <p className="font-mono text-xs break-all text-muted-foreground" data-testid="pitr-current">
                    {current ?? <span className="text-muted-foreground">—</span>}
                </p>
            </section>

            <section className="flex flex-col gap-3 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">{t("Restore")}</h3>

                <div className="flex flex-col gap-1">
                    <Label htmlFor="pitr-time">{t("Time (ISO or epoch-ms, last 30 days)")}</Label>
                    <div className="flex items-center gap-2">
                        <Input data-testid="pitr-time" id="pitr-time" onChange={onTimeChange} placeholder="2026-06-01T00:00:00.000Z" value={time} />
                        <Button data-testid="pitr-preview" disabled={busy || time.trim() === ""} onClick={onPreview} size="sm" type="button" variant="outline">
                            {t("Preview")}
                        </Button>
                    </div>
                    {preview !== null && (
                        <p className="font-mono text-xs break-all text-muted-foreground" data-testid="pitr-preview-bookmark">
                            {t("Bookmark for that time")}: {preview}
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-1">
                    <Label htmlFor="pitr-bookmark">{t("Or an explicit bookmark (wins over time)")}</Label>
                    <Input data-testid="pitr-bookmark" id="pitr-bookmark" onChange={onBookmarkChange} placeholder={t("bookmark string")} value={bookmark} />
                </div>

                <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground" htmlFor="pitr-restart">
                    <input
                        checked={restart}
                        className="size-4 accent-primary"
                        data-testid="pitr-restart"
                        id="pitr-restart"
                        onChange={onRestartChange}
                        type="checkbox"
                    />
                    {t("Restart the shard now so recovery applies immediately")}
                </Label>

                <div>
                    <ConfirmButton confirmLabel={t("Confirm restore")} disabled={busy || !canRestore} onConfirm={onConfirmRestore} testId="pitr-restore">
                        {t("Restore")}
                    </ConfirmButton>
                </div>
            </section>

            {restored !== null && (
                <section className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="pitr-result">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{t("Restore armed")}</h3>
                        <Badge variant={restored.restarted ? "destructive" : "secondary"}>
                            {restored.restarted ? t("restarted now") : t("on next restart")}
                        </Badge>
                    </div>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                        {t("Restored to")}: {restored.restoredTo}
                    </p>
                    <p className="font-mono text-xs break-all text-muted-foreground" data-testid="pitr-undo-bookmark">
                        {t("Undo bookmark")}: {restored.undoBookmark}
                    </p>
                    <div>
                        <ConfirmButton confirmLabel={t("Confirm undo")} disabled={busy} onConfirm={onUndo} testId="pitr-undo">
                            {t("Undo restore")}
                        </ConfirmButton>
                    </div>
                </section>
            )}
        </div>
    );
};

export type { PitrPanelProps };
