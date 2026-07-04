import { useLunora } from "@lunora/react";
import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import type {
    QueueMessageOutcome,
    QueueMessageRow,
    QueueMessagesResult,
    QueuesResult,
    ReplayQueueMessageResult,
    SendQueueMessageResult,
} from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface QueuesPanelProps {
    /** Newest-N consumed messages to load into the log (default 200). */
    readonly limit?: number;
}

const SEND_QUEUE_MESSAGE = adminRef(ADMIN_FUNCTIONS.sendQueueMessage);
const REPLAY_QUEUE_MESSAGE = adminRef(ADMIN_FUNCTIONS.replayQueueMessage);
const CLEAR_QUEUE_MESSAGES = adminRef(ADMIN_FUNCTIONS.clearQueueMessages);

/** Which sub-view of the Queues panel is showing. */
type QueuesTab = "declared" | "messages" | "send";

/** Longest body preview rendered inline in the log; the full body is in the cell `title`. */
const BODY_PREVIEW_MAX = 96;

/** JSON-encode a captured body for a one-line preview, tolerating non-encodable values. */
const formatBody = (value: unknown): string => {
    // JSON.stringify(undefined) is the one value it returns non-string for; guard it up front.
    if (value === undefined) {
        return "—";
    }

    try {
        return JSON.stringify(value);
    } catch {
        // Captured bodies come from JSON.parse, so this only fires for exotic values (BigInt/cyclic).
        return "[unserializable]";
    }
};

/** Truncate a preview string to {@link BODY_PREVIEW_MAX} with an ellipsis. */
const truncate = (text: string): string => (text.length > BODY_PREVIEW_MAX ? `${text.slice(0, BODY_PREVIEW_MAX)}…` : text);

/** Map a message's terminal disposition to a badge variant (ack neutral, retry outlined, error destructive). */
const outcomeVariant = (outcome: QueueMessageOutcome): "destructive" | "outline" | "secondary" => {
    if (outcome === "error") {
        return "destructive";
    }

    if (outcome === "retry") {
        return "outline";
    }

    return "secondary";
};

/**
 * The Queues inspector — three tabs over the deployment's Cloudflare Queues.
 *
 * Declared: the `defineQueue` producers statically discovered by `@lunora/codegen` (export, deployed name, push/pull mode, binding, DLQ).
 *
 * Messages: the dev consumed-message log. Cloudflare Queues expose no peek API, so this shows what push consumers actually processed (id, attempts, ack/retry/error outcome, dead-letter flag, body) — captured on consume by the generated `queue()` handler — not pending depth. Each row can be replayed / redriven back onto its origin (or, for a dead-lettered message, its parent) queue, and the whole log cleared.
 *
 * Send: enqueue a JSON body (optionally a batch, with an optional delay) to any declared producer, to exercise a consumer end to end.
 *
 * All three read/write reserved admin RPCs over the {@link useLunora} client, gated by the server's `LUNORA_ADMIN_TOKEN`.
 */
const QueuesPanel = ({ limit = 200 }: QueuesPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [tab, setTab] = useState<QueuesTab>("declared");
    const [actionError, setActionError] = useState<null | string>(null);

    // Deployment-wide metadata (root shard), so no shard selector is needed.
    const { data: queuesData, error: queuesError, errorSource: queuesErrorSource } = useAdminQuery<QueuesResult>(ADMIN_FUNCTIONS.listQueues, {});

    // The consumed-message log is a single root-shard table with no write-flush to
    // subscribe to, so it polls (paused while the tab is hidden) below.
    const {
        data: messagesData,
        error: messagesError,
        errorSource: messagesErrorSource,
        refetch: refetchMessages,
    } = useAdminQuery<QueueMessagesResult>(ADMIN_FUNCTIONS.getQueueMessages, { limit });

    const queues = useMemo(
        () => (Array.isArray(queuesData?.queues) ? [...queuesData.queues].toSorted((a, b) => a.exportName.localeCompare(b.exportName)) : []),
        [queuesData],
    );
    const messages = useMemo<QueueMessageRow[]>(() => messagesData?.entries ?? [], [messagesData]);

    const [selectedExport, setSelectedExport] = useState<string>("");
    const [bodyText, setBodyText] = useState<string>("");
    const [delayText, setDelayText] = useState<string>("");
    const [batchMode, setBatchMode] = useState<boolean>(false);
    const [sending, setSending] = useState<boolean>(false);
    const [replayingId, setReplayingId] = useState<null | string>(null);

    // Default the Send target to the first declared queue until the user picks one.
    const selectedExportName = useMemo(() => {
        if (queues.some((queue) => queue.exportName === selectedExport)) {
            return selectedExport;
        }

        return queues[0]?.exportName ?? "";
    }, [queues, selectedExport]);

    const readError = tab === "messages" ? messagesError : queuesError;
    const readErrorSource = tab === "messages" ? messagesErrorSource : queuesErrorSource;
    const error = readError ?? actionError;
    const errorSource = readError === null ? actionError : readErrorSource;

    // Keep the consumed-message log live without a manual refresh.
    useAutoRefresh(() => {
        refetchMessages();
    }, true);

    const send = useCallback(async (): Promise<void> => {
        setActionError(null);

        const exportName = selectedExportName;

        if (exportName === "") {
            return;
        }

        let body: unknown = null;
        const trimmedBody = bodyText.trim();

        if (trimmedBody !== "") {
            try {
                body = JSON.parse(trimmedBody);
            } catch {
                setActionError(t("Body must be valid JSON."));

                return;
            }
        }

        let delaySeconds: number | undefined;
        const trimmedDelay = delayText.trim();

        if (trimmedDelay !== "") {
            const parsed = Number(trimmedDelay);

            if (!Number.isFinite(parsed) || parsed < 0) {
                setActionError(t("Delay must be a non-negative number of seconds."));

                return;
            }

            delaySeconds = parsed;
        }

        if (batchMode && !Array.isArray(body)) {
            setActionError(t("Batch mode needs a JSON array body — each element is enqueued as one message."));

            return;
        }

        setSending(true);

        try {
            const args = batchMode ? { batch: body as unknown[], delaySeconds, exportName } : { body, delaySeconds, exportName };

            (await client.query(SEND_QUEUE_MESSAGE, args, callOptions(""))) as SendQueueMessageResult;
            refetchMessages();
        } catch (error_) {
            setActionError(errorMessage(error_));
        } finally {
            setSending(false);
        }
    }, [batchMode, bodyText, client, delayText, refetchMessages, selectedExportName, t]);

    const replay = useCallback(
        async (id: string): Promise<void> => {
            setActionError(null);
            setReplayingId(id);

            try {
                (await client.query(REPLAY_QUEUE_MESSAGE, { id }, callOptions(""))) as ReplayQueueMessageResult;
                refetchMessages();
            } catch (error_) {
                setActionError(errorMessage(error_));
            } finally {
                setReplayingId(null);
            }
        },
        [client, refetchMessages],
    );

    const clearLog = useCallback(async (): Promise<void> => {
        setActionError(null);

        try {
            await client.query(CLEAR_QUEUE_MESSAGES, {}, callOptions(""));
            refetchMessages();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }
    }, [client, refetchMessages]);

    const onSelectTab = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
        const next = event.currentTarget.dataset["tab"];

        if (next === "declared" || next === "messages" || next === "send") {
            setTab(next);
        }
    }, []);

    const onSelectExport = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedExport(event.currentTarget.value);
    }, []);

    const onBodyChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
        setBodyText(event.currentTarget.value);
    }, []);

    const onDelayChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setDelayText(event.currentTarget.value);
    }, []);

    const onBatchModeChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setBatchMode(event.currentTarget.checked);
    }, []);

    const onSend = useCallback((): void => {
        fireAndForget(send());
    }, [send]);

    const onReplay = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const { id } = event.currentTarget.dataset;

            if (id !== undefined) {
                fireAndForget(replay(id));
            }
        },
        [replay],
    );

    const onClear = useCallback((): void => {
        fireAndForget(clearLog());
    }, [clearLog]);

    const tabLabel = (value: QueuesTab): string => {
        if (value === "messages") {
            return t("Messages");
        }

        if (value === "send") {
            return t("Send");
        }

        return t("Declared");
    };

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-queues-panel">
            <div className="flex items-center gap-1" data-testid="queues-tabs" role="tablist">
                {(["declared", "messages", "send"] as const).map((value) => (
                    <Button
                        aria-selected={tab === value}
                        data-tab={value}
                        data-testid={`queues-tab-${value}`}
                        key={value}
                        onClick={onSelectTab}
                        role="tab"
                        size="sm"
                        type="button"
                        variant={tab === value ? "secondary" : "ghost"}
                    >
                        {tabLabel(value)}
                    </Button>
                ))}
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="queues-error" />}

            {tab === "declared" && (
                <div className="flex flex-col gap-4" data-testid="queues-declared">
                    <p className="text-sm text-muted-foreground">
                        {t(
                            "Queues are declared in code with defineQueue. Enqueue from a mutation or action with ctx.queues.<name>.send(...); push consumers process batches in the worker.",
                        )}
                    </p>

                    {queuesData !== undefined && queues.length === 0 ? (
                        <EmptyState
                            description={t(
                                "No defineQueue is declared in lunora/queues.ts in this deployment. Add one to offload async work to a Cloudflare Queue.",
                            )}
                            testId="queues-empty"
                            title={t("No queues defined")}
                        />
                    ) : (
                        <Card className="overflow-hidden py-0">
                            <CardContent className="px-0">
                                <Table data-testid="queues-table">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("Export")}</TableHead>
                                            <TableHead>{t("Queue")}</TableHead>
                                            <TableHead>{t("Mode")}</TableHead>
                                            <TableHead>{t("Binding")}</TableHead>
                                            <TableHead>{t("Dead-letter")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {queues.map((queue) => (
                                            <TableRow data-testid={`queues-row-${queue.exportName}`} key={queue.exportName}>
                                                <TableCell className="font-mono text-xs">{queue.exportName}</TableCell>
                                                <TableCell className="font-mono text-xs text-muted-foreground">{queue.name}</TableCell>
                                                <TableCell className="font-mono text-xs text-muted-foreground">{queue.mode}</TableCell>
                                                <TableCell className="font-mono text-xs text-muted-foreground">{queue.binding}</TableCell>
                                                <TableCell className="font-mono text-xs text-muted-foreground">{queue.deadLetterQueue ?? "—"}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}

            {tab === "messages" && (
                <div className="flex flex-col gap-4" data-testid="queues-messages">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm text-muted-foreground">
                            {t("Cloudflare Queues have no peek API, so this is what push consumers actually processed — not pending depth.")}
                        </p>
                        <Button
                            className="ml-auto"
                            data-testid="queues-clear"
                            disabled={messages.length === 0}
                            onClick={onClear}
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            {t("Clear log")}
                        </Button>
                        {messages.length > 0 && (
                            <Badge data-testid="queues-count" variant="secondary">
                                {t("{count} messages", { count: messages.length })}
                            </Badge>
                        )}
                    </div>

                    {messagesError === null && messages.length === 0 ? (
                        <EmptyState
                            description={t(
                                "Consumed messages appear here once a push consumer processes a batch in dev. Send one from the Send tab to see it captured.",
                            )}
                            testId="queues-messages-empty"
                            title={t("No consumed messages yet.")}
                        />
                    ) : (
                        <Card className="overflow-hidden py-0">
                            <CardContent className="px-0">
                                <ScrollArea className="max-h-[32rem]" data-testid="queues-messages-scroll">
                                    <Table data-testid="queues-messages-table">
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t("Export")}</TableHead>
                                                <TableHead>{t("Message")}</TableHead>
                                                <TableHead>{t("Attempts")}</TableHead>
                                                <TableHead>{t("Outcome")}</TableHead>
                                                <TableHead>{t("Body")}</TableHead>
                                                <TableHead>{t("Captured")}</TableHead>
                                                <TableHead />
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {messages.map((message) => {
                                                const body = formatBody(message.body);

                                                return (
                                                    <TableRow data-testid={`queues-message-${message.id}`} key={message.id}>
                                                        <TableCell className="font-mono text-xs">{message.exportName ?? message.queue}</TableCell>
                                                        <TableCell
                                                            className="max-w-[16ch] truncate font-mono text-xs text-muted-foreground"
                                                            title={message.messageId}
                                                        >
                                                            {message.messageId}
                                                        </TableCell>
                                                        <TableCell className="font-mono text-xs tabular-nums">{message.attempts}</TableCell>
                                                        <TableCell>
                                                            <span className="inline-flex items-center gap-1">
                                                                <Badge data-testid={`queues-outcome-${message.id}`} variant={outcomeVariant(message.outcome)}>
                                                                    {message.outcome}
                                                                </Badge>
                                                                {message.deadLettered && (
                                                                    <Badge data-testid={`queues-dlq-${message.id}`} variant="destructive">
                                                                        {t("DLQ")}
                                                                    </Badge>
                                                                )}
                                                            </span>
                                                        </TableCell>
                                                        <TableCell className="max-w-[32ch] truncate font-mono text-xs text-muted-foreground" title={body}>
                                                            {truncate(body)}
                                                        </TableCell>
                                                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                                                            {formatTimestamp(message.capturedAt, "—")}
                                                        </TableCell>
                                                        <TableCell>
                                                            <Button
                                                                data-id={message.id}
                                                                data-testid={`queues-replay-${message.id}`}
                                                                disabled={replayingId === message.id}
                                                                onClick={onReplay}
                                                                size="xs"
                                                                type="button"
                                                                variant="outline"
                                                            >
                                                                {replayingId === message.id ? t("Replaying…") : t("Replay")}
                                                            </Button>
                                                        </TableCell>
                                                    </TableRow>
                                                );
                                            })}
                                        </TableBody>
                                    </Table>
                                </ScrollArea>
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}

            {tab === "send" && (
                <div className="flex flex-col gap-3" data-testid="queues-send">
                    <p className="text-sm text-muted-foreground">
                        {t("Enqueue a JSON message to a declared producer to exercise its consumer. Nothing is captured until the consumer processes it.")}
                    </p>

                    {queues.length === 0 ? (
                        <EmptyState
                            description={t("Declare a queue with defineQueue in lunora/queues.ts to enqueue a test message.")}
                            testId="queues-send-empty"
                            title={t("No queues to send to")}
                        />
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <select
                                    aria-label={t("Queue")}
                                    className="h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                                    data-testid="queues-send-select"
                                    onChange={onSelectExport}
                                    value={selectedExportName}
                                >
                                    {queues.map((queue) => (
                                        <option key={queue.exportName} value={queue.exportName}>
                                            {queue.exportName}
                                        </option>
                                    ))}
                                </select>
                                <Input
                                    aria-label={t("Delay (seconds)")}
                                    className="max-w-36"
                                    data-testid="queues-send-delay"
                                    min={0}
                                    onChange={onDelayChange}
                                    placeholder={t("Delay (s)")}
                                    type="number"
                                    value={delayText}
                                />
                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground" htmlFor="queues-send-batch">
                                    <input
                                        checked={batchMode}
                                        data-testid="queues-send-batch"
                                        id="queues-send-batch"
                                        onChange={onBatchModeChange}
                                        type="checkbox"
                                    />
                                    {t("Send as batch (JSON array)")}
                                </label>
                                <Button
                                    className="ml-auto"
                                    data-testid="queues-send-button"
                                    disabled={sending || selectedExportName === ""}
                                    onClick={onSend}
                                    type="button"
                                >
                                    {sending ? t("Sending…") : t("Send message")}
                                </Button>
                            </div>
                            <Textarea
                                aria-label={t("Message body (JSON)")}
                                className="font-mono"
                                data-testid="queues-send-body"
                                onChange={onBodyChange}
                                placeholder={batchMode ? '[ { "hello": "world" } ]' : '{ "hello": "world" }'}
                                value={bodyText}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default QueuesPanel;
