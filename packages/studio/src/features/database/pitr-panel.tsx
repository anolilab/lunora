import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import type { PitrBookmarkResult, PitrRestoreResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";

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
 * bookmark via the `__lunora_admin__:pitrRestore` RPC, surfacing the returned
 * undo bookmark so the restore can be reversed. All ops run over the
 * {@link useLunora} client and are gated by the server's `LUNORA_ADMIN_TOKEN`.
 *
 * In-place recovery covers the last 30 days; for older or off-platform recovery
 * use the snapshot tier (`lunora backup` / the backup registry item).
 */
export const PitrPanel = ({ initialShardKey }: PitrPanelProps): ReactElement => {
    const client = useLunora();
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
        }

        setBusy(false);
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the read targets `shardKey` (state seeded from the prop), which is listed; depending on the prop would ignore the operator's own shard edit
    }, [client, shardKey]);

    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async refresh of the current bookmark, not derived state
        fireAndForget(refresh());
    }, [refresh]);

    // The current bookmark advances on every shard write; poll it so it doesn't go
    // stale (there's no Refresh button). Lightweight — only updates the displayed
    // bookmark, never toggles `busy` or clobbers an in-flight preview/restore.
    useAutoRefresh(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = (await client.query(GET_BOOKMARK, {}, callOptions(shardKey))) as PitrBookmarkResult;

                    setCurrent(result.current);
                } catch {
                    // Leave the last-known bookmark on a transient read failure.
                }
            })(),
        );
    }, true);

    const onTimeChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setTime(event.target.value);
    };

    const onBookmarkChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setBookmark(event.target.value);
    };

    const onRestartChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setRestart(event.target.checked);
    };

    const onPreview = (): void => {
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
                }

                setBusy(false);
            })(),
        );
    };

    const runRestore = (args: { bookmark?: string; restart?: boolean; time?: string }): void => {
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
                }

                setBusy(false);
            })(),
        );
    };

    // A restore needs an explicit bookmark or a time to aim at.
    const canRestore = bookmark.trim() !== "" || time.trim() !== "";

    // Name what is about to happen. The most destructive action here used to
    // confirm with a bare "Confirm restore", which said neither WHICH shard would
    // be rewound — this view is shard-scoped and an operator may have several
    // open — nor to WHEN. Mirrors `onConfirmRestore`'s own bookmark-wins-over-time
    // precedence, so the label can't promise a different target than the one sent.
    const confirmRestoreLabel = t("Restore {shard} to {target}?", {
        shard: shardKey === "" ? t("root") : shardKey,
        target: bookmark.trim() === "" ? time.trim() : t("the given bookmark"),
    });

    const onConfirmRestore = (): void => {
        const args: { bookmark?: string; restart?: boolean; time?: string } = restart ? { restart: true } : {};

        if (bookmark.trim() === "") {
            args.time = time.trim();
        } else {
            args.bookmark = bookmark.trim();
        }

        runRestore(args);
    };

    const onUndo = (): void => {
        if (restored === null) {
            return;
        }

        runRestore(restart ? { bookmark: restored.undoBookmark, restart: true } : { bookmark: restored.undoBookmark });
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-pitr">
            <div className="flex flex-wrap items-center gap-3">
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

            <section className="rounded-xl border border-border bg-card p-3 shadow-xs">
                <h3 className="mb-2 text-sm font-semibold">{t("Current bookmark")}</h3>
                <p className="font-mono text-xs break-all text-muted-foreground" data-testid="pitr-current">
                    {current ?? <span className="text-muted-foreground">—</span>}
                </p>
            </section>

            <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-xs">
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
                    <ConfirmButton confirmLabel={confirmRestoreLabel} disabled={busy || !canRestore} onConfirm={onConfirmRestore} testId="pitr-restore">
                        {t("Restore")}
                    </ConfirmButton>
                </div>
            </section>

            {restored !== null && (
                <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs" data-testid="pitr-result">
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
