import type { ReturnOf } from "@lunora/client";
import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { formatBytes, formatDateTime, formatNumber } from "./format";
import { FormError, StatusBadge } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

type BackupRow = ReturnOf<typeof api.tenant_backups.list>[number];

const STATUS_TONE: Record<BackupRow["status"], "danger" | "success" | "warning"> = { failed: "danger", running: "warning", succeeded: "success" };

const TRIGGER_LABEL: Record<BackupRow["trigger"], string> = { manual: "Manual", "pre-restore": "Before restore", scheduled: "Daily" };

const FILENAME_RE = /filename="(?<name>[^"]+)"/u;

/** POST to one of the `/v1/backups*` routes; resolves to the response, or throws its error message. */
const post = async (path: string, body: Record<string, string>): Promise<Response> => {
    const response = await fetch(path, {
        body: JSON.stringify(body),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok && response.status !== 207) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;

        throw new Error(payload?.error ?? `request failed (${String(response.status)})`);
    }

    return response;
};

/** Save a streamed snapshot through a transient object URL — the object itself is never public. */
const download = async (organizationId: OrgId, backupId: string): Promise<void> => {
    const response = await post("/v1/backups/download", { backupId, organizationId });
    const filename = FILENAME_RE.exec(response.headers.get("content-disposition") ?? "")?.groups?.["name"] ?? "backup.ndjson.gz";
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
};

/** The size of a snapshot, or what a restore wrote. */
const describeRow = (row: BackupRow): string => {
    if (row.operation === "backup") {
        return row.bytes === undefined ? "—" : formatBytes(row.bytes);
    }

    if (row.restoreInserted === undefined) {
        return "—";
    }

    const rejected = row.restoreRowErrors ? ` · ${formatNumber(row.restoreRowErrors)} rejected` : "";

    return `${formatNumber(row.restoreInserted)} rows back · ${formatNumber(row.restoreConflicts ?? 0)} already present${rejected}`;
};

/**
 * A project's production data backups: the daily snapshots, "Back up now",
 * download, and restore behind a confirm step that names the snapshot.
 *
 * The restore copy is deliberately explicit about what it does. The tenant
 * import is append-only, so a restore brings back rows deleted since the
 * snapshot and leaves everything else — including rows edited since — as it is.
 * Someone expecting a rewind would otherwise read "restored" as a promise the
 * platform does not keep.
 */
export const BackupsSection = ({ organizationId, projectId }: { organizationId: OrgId; projectId: ProjectId }): ReactElement => {
    // `undefined` while loading and after an identity switch — every read below guards it.
    const rows = useQuery(api.tenant_backups.list, { organizationId, projectId });
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState<BackupRow | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [notice, setNotice] = useState<null | string>(null);

    const run = (work: () => Promise<null | string>): void => {
        setBusy(true);
        setError(null);
        setNotice(null);
        void work()
            .then(setNotice)
            .catch((error_: unknown) => {
                setError(error_ instanceof Error ? error_.message : "request failed");
            })
            .finally(() => {
                setBusy(false);
            });
    };

    const running = rows?.some((row) => row.status === "running") ?? false;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Backups</CardTitle>
                <CardDescription>
                    Production data is snapshotted daily and kept per your plan. Restoring a snapshot brings back rows deleted since it was taken; rows that
                    still exist keep their current values and newer rows are left alone. A snapshot of the current data is taken first. Files in storage buckets
                    are not included.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <Button
                    className="self-start"
                    disabled={busy || running}
                    onClick={() => {
                        run(async () => {
                            await post("/v1/backups", { organizationId, projectId });

                            return "Backup complete.";
                        });
                    }}
                    size="sm"
                    type="button"
                >
                    {busy ? "Working…" : "Back up now"}
                </Button>
                <FormError message={error} />
                {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
                {confirming ? (
                    <div className="flex flex-col gap-3 rounded-md border border-warning/40 p-4 text-sm" role="alertdialog">
                        <p className="m-0">
                            Restore the snapshot from <span className="font-medium">{formatDateTime(confirming.createdAt)}</span>? Rows deleted since then come
                            back; nothing is removed or reverted. The current data is backed up first.
                        </p>
                        <div className="flex gap-2">
                            <Button
                                disabled={busy}
                                onClick={() => {
                                    const target = confirming;

                                    setConfirming(null);
                                    run(async () => {
                                        const response = await post("/v1/backups/restore", { backupId: target._id, organizationId });

                                        return response.status === 207
                                            ? "Restore was partial — some data could not be written. Run it again."
                                            : "Restore complete.";
                                    });
                                }}
                                size="sm"
                                type="button"
                                variant="destructive"
                            >
                                Restore {formatDateTime(confirming.createdAt)}
                            </Button>
                            <Button
                                onClick={() => {
                                    setConfirming(null);
                                }}
                                size="sm"
                                type="button"
                                variant="ghost"
                            >
                                Cancel
                            </Button>
                        </div>
                    </div>
                ) : null}
                {rows === undefined ? <span className="text-sm text-muted-foreground">Loading…</span> : null}
                {rows?.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No backups yet — the first daily snapshot runs within the day.</span>
                ) : null}
                {rows && rows.length > 0 ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Time</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Size</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="sr-only">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row._id}>
                                    <TableCell className="text-muted-foreground">{formatDateTime(row.createdAt)}</TableCell>
                                    <TableCell>{row.operation === "restore" ? "Restore" : TRIGGER_LABEL[row.trigger]}</TableCell>
                                    <TableCell>{describeRow(row)}</TableCell>
                                    <TableCell>
                                        <span title={row.error}>
                                            <StatusBadge tone={STATUS_TONE[row.status]}>{row.status}</StatusBadge>
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {row.operation === "backup" && row.status === "succeeded" ? (
                                            <span className="flex justify-end gap-1">
                                                <Button
                                                    disabled={busy}
                                                    onClick={() => {
                                                        run(async () => {
                                                            await download(organizationId, row._id);

                                                            return null;
                                                        });
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    Download
                                                </Button>
                                                <Button
                                                    disabled={busy || running}
                                                    onClick={() => {
                                                        setConfirming(row);
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    Restore
                                                </Button>
                                            </span>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : null}
            </CardContent>
        </Card>
    );
};
