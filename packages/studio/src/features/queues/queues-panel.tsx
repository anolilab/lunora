import { useLunora } from "@lunora/react";
import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import ErrorAlert from "../../components/error-alert";
import { Alert } from "../../components/ui/alert";
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
    QueueMetadata,
    QueuesResult,
    ReplayQueueMessageResult,
    SendQueueMessageResult,
} from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { computeQueueReliability } from "./reliability";

interface QueuesPanelProps {
    /** Newest-N consumed messages to load into the log (default {@link DEFAULT_MESSAGE_LIMIT}). */
    readonly limit?: number;
}

/** Default `limit` for the consumed-message log — applied in the body, not as a param default (see {@link QueuesPanel}). */
const DEFAULT_MESSAGE_LIMIT = 200;

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

/** Human label for a sub-tab. */
const tabLabel = (value: QueuesTab, t: ReturnType<typeof useT>): string => {
    if (value === "messages") {
        return t("Messages");
    }

    if (value === "send") {
        return t("Send");
    }

    return t("Declared");
};

/** Declared-producers tab: the `defineQueue` producers `@lunora/codegen` statically discovered. */
const QueuesDeclaredTab = ({ loaded, queues }: { loaded: boolean; queues: QueueMetadata[] }): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-4" data-testid="queues-declared">
            <p className="text-sm text-muted-foreground">
                {t(
                    "Queues are declared in code with defineQueue. Enqueue from a mutation or action with ctx.queues.<name>.send(...); push consumers process batches in the worker.",
                )}
            </p>

            {loaded && queues.length === 0 ? (
                <EmptyState
                    description={t("No defineQueue is declared in lunora/queues.ts in this deployment. Add one to offload async work to a Cloudflare Queue.")}
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
    );
};

/** One consumed-message row in the log; its Replay button is disabled while any replay is in flight. */
const QueueLogRow = ({
    message,
    onReplay,
    replayingId,
}: {
    message: QueueMessageRow;
    onReplay: (event: MouseEvent<HTMLButtonElement>) => void;
    replayingId: null | string;
}): ReactElement => {
    const t = useT();
    const body = formatBody(message.body);

    return (
        <TableRow data-testid={`queues-message-${message.id}`}>
            <TableCell className="font-mono text-xs">{message.exportName ?? message.queue}</TableCell>
            <TableCell className="max-w-[16ch] truncate font-mono text-xs text-muted-foreground" title={message.messageId}>
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
            <TableCell className="text-xs text-muted-foreground tabular-nums">{formatTimestamp(message.capturedAt, "—")}</TableCell>
            <TableCell>
                <Button
                    data-id={message.id}
                    data-testid={`queues-replay-${message.id}`}
                    disabled={replayingId !== null}
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
};

/** Consumed-message log tab: what push consumers actually processed (Cloudflare Queues have no peek API). */
const QueuesMessagesTab = ({
    hasError,
    messages,
    onClear,
    onReplay,
    replayingId,
}: {
    hasError: boolean;
    messages: QueueMessageRow[];
    onClear: () => void;
    onReplay: (event: MouseEvent<HTMLButtonElement>) => void;
    replayingId: null | string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-4" data-testid="queues-messages">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    {t("Cloudflare Queues have no peek API, so this is what push consumers actually processed — not pending depth.")}
                </p>
                <div className="ml-auto">
                    <ConfirmButton
                        confirmLabel={t("Clear {count} messages?", { count: messages.length })}
                        disabled={messages.length === 0}
                        onConfirm={onClear}
                        testId="queues-clear"
                    >
                        {t("Clear log")}
                    </ConfirmButton>
                </div>
                {messages.length > 0 && (
                    <Badge data-testid="queues-count" variant="secondary">
                        {t("{count} messages", { count: messages.length })}
                    </Badge>
                )}
            </div>

            {!hasError && messages.length === 0 ? (
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
                                    {messages.map((message) => (
                                        <QueueLogRow key={message.id} message={message} onReplay={onReplay} replayingId={replayingId} />
                                    ))}
                                </TableBody>
                            </Table>
                        </ScrollArea>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

/** Props for the Send tab — the controlled form state plus its change/submit handlers. */
interface QueuesSendTabProps {
    batchMode: boolean;
    bodyText: string;
    delayText: string;
    onBatchModeChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onBodyChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onDelayChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onSelectExport: (event: ChangeEvent<HTMLSelectElement>) => void;
    onSend: () => void;
    queues: QueueMetadata[];
    selectedExportName: string;
    sending: boolean;
}

/** Send tab: enqueue a JSON body (optionally a delayed batch) to any declared producer to exercise its consumer. */
const QueuesSendTab = ({
    batchMode,
    bodyText,
    delayText,
    onBatchModeChange,
    onBodyChange,
    onDelayChange,
    onSelectExport,
    onSend,
    queues,
    selectedExportName,
    sending,
}: QueuesSendTabProps): ReactElement => {
    const t = useT();

    return (
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
                            <input checked={batchMode} data-testid="queues-send-batch" id="queues-send-batch" onChange={onBatchModeChange} type="checkbox" />
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
    );
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
 *
 * The tab bodies are extracted into sibling components so the panel stays small
 * and each tab is independently readable; state and actions live here and flow
 * down as props. No manual memoization — React Compiler caches derived values and
 * handlers for the whole component. A few patterns keep it compilable (each bails
 * `BuildHIR` in the compiler version this repo pins): the `limit` default is applied
 * in the body (never as a destructuring default in the param signature), and the async
 * actions keep their `try/catch` blocks simple — no `finally` clause, and no
 * conditional / optional-chaining expression *inside* a `try` body.
 */
const QueuesPanel = ({ limit }: QueuesPanelProps): ReactElement => {
    const messageLimit = limit ?? DEFAULT_MESSAGE_LIMIT;
    const client = useLunora();
    const t = useT();

    const [tab, setTab] = useState<QueuesTab>("declared");
    const [actionError, setActionError] = useState<null | string>(null);

    // Deployment-wide metadata (root shard), so no shard selector is needed.
    const { data: queuesData, error: queuesError, errorSource: queuesErrorSource } = useAdminQuery<QueuesResult>(ADMIN_FUNCTIONS.listQueues, {});

    // The consumed-message log is a single root-shard table with no write-flush to
    // subscribe to, so it polls (only while the Messages tab is visible) below.
    const {
        data: messagesData,
        error: messagesError,
        errorSource: messagesErrorSource,
        refetch: refetchMessages,
    } = useAdminQuery<QueueMessagesResult>(ADMIN_FUNCTIONS.getQueueMessages, { limit: messageLimit });

    const queues = Array.isArray(queuesData?.queues) ? [...queuesData.queues].toSorted((a, b) => a.exportName.localeCompare(b.exportName)) : [];
    const messages: QueueMessageRow[] = messagesData?.entries ?? [];

    // Reliability nudge: a queue with no `deadLetterQueue` drops messages once
    // they exhaust retries (push and pull alike — mirrors the `queue_without_dlq`
    // advisor), paired with a count of messages actually dead-lettered in the
    // loaded log so the warning is concrete once it bites.
    const { deadLetteredCount, queuesWithoutDlq, showReliabilityWarning } = computeQueueReliability(queues, messages);

    const [selectedExport, setSelectedExport] = useState<string>("");
    const [bodyText, setBodyText] = useState<string>("");
    const [delayText, setDelayText] = useState<string>("");
    const [batchMode, setBatchMode] = useState<boolean>(false);
    const [sending, setSending] = useState<boolean>(false);
    const [replayingId, setReplayingId] = useState<null | string>(null);

    // Default the Send target to the first declared queue until the user picks one.
    const selectedExportName = queues.some((queue) => queue.exportName === selectedExport) ? selectedExport : (queues[0]?.exportName ?? "");

    const readError = tab === "messages" ? messagesError : queuesError;
    const readErrorSource = tab === "messages" ? messagesErrorSource : queuesErrorSource;
    const error = readError ?? actionError;
    const errorSource = readError === null ? actionError : readErrorSource;

    // Keep the consumed-message log live without a manual refresh — but only while
    // the Messages tab is visible, so the Declared / Send tabs don't poll the RPC.
    useAutoRefresh(() => {
        refetchMessages();
    }, tab === "messages");

    const send = async (): Promise<void> => {
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

        // `args` is built before the `try`: React Compiler bails on a conditional (or
        // optional-chaining) expression *inside* a try/catch. And no `finally` (that also
        // bails) — the catch swallows the error, so the trailing `setSending(false)` always runs.
        const args = batchMode ? { batch: body as unknown[], delaySeconds, exportName } : { body, delaySeconds, exportName };

        try {
            (await client.query(SEND_QUEUE_MESSAGE, args, callOptions(""))) as SendQueueMessageResult;
            refetchMessages();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }

        setSending(false);
    };

    const replay = async (id: string): Promise<void> => {
        setActionError(null);
        setReplayingId(id);

        // No `finally` (it bails the compiler): the catch swallows, so `setReplayingId(null)` always runs.
        try {
            (await client.query(REPLAY_QUEUE_MESSAGE, { id }, callOptions(""))) as ReplayQueueMessageResult;
            refetchMessages();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }

        setReplayingId(null);
    };

    const clearLog = async (): Promise<void> => {
        setActionError(null);

        try {
            await client.query(CLEAR_QUEUE_MESSAGES, {}, callOptions(""));
            refetchMessages();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }
    };

    const onSelectTab = (event: MouseEvent<HTMLButtonElement>): void => {
        const next = event.currentTarget.dataset["tab"];

        if (next === "declared" || next === "messages" || next === "send") {
            setTab(next);
        }
    };

    const onSelectExport = (event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedExport(event.currentTarget.value);
    };

    const onBodyChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
        setBodyText(event.currentTarget.value);
    };

    const onDelayChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setDelayText(event.currentTarget.value);
    };

    const onBatchModeChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setBatchMode(event.currentTarget.checked);
    };

    const onSend = (): void => {
        fireAndForget(send());
    };

    const onReplay = (event: MouseEvent<HTMLButtonElement>): void => {
        const { id } = event.currentTarget.dataset;

        if (id !== undefined) {
            fireAndForget(replay(id));
        }
    };

    const onClear = (): void => {
        fireAndForget(clearLog());
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
                        {tabLabel(value, t)}
                    </Button>
                ))}
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="queues-error" />}

            {showReliabilityWarning && (
                <Alert
                    icon={
                        <span aria-hidden="true" className="text-base leading-none">
                            ⚠
                        </span>
                    }
                    testId="queues-dlq-warning"
                    variant="warning"
                >
                    <div className="flex flex-col gap-1">
                        {queuesWithoutDlq.length > 0 && (
                            <>
                                <p className="font-medium">
                                    {t("No dead-letter queue on {queues}.", { queues: queuesWithoutDlq.map((queue) => queue.name).join(", ") })}
                                </p>
                                <p className="text-muted-foreground">
                                    {t("Exhausted messages are dropped after retries. Add a deadLetterQueue to capture them.")}
                                </p>
                            </>
                        )}
                        {deadLetteredCount > 0 && (
                            <p className={queuesWithoutDlq.length > 0 ? "text-muted-foreground" : "font-medium"}>
                                {deadLetteredCount === 1
                                    ? t("1 message was recently dead-lettered.")
                                    : t("{count} messages were recently dead-lettered.", { count: deadLetteredCount })}
                            </p>
                        )}
                    </div>
                </Alert>
            )}

            {tab === "declared" && <QueuesDeclaredTab loaded={queuesData !== undefined} queues={queues} />}

            {tab === "messages" && (
                <QueuesMessagesTab hasError={messagesError !== null} messages={messages} onClear={onClear} onReplay={onReplay} replayingId={replayingId} />
            )}

            {tab === "send" && (
                <QueuesSendTab
                    batchMode={batchMode}
                    bodyText={bodyText}
                    delayText={delayText}
                    onBatchModeChange={onBatchModeChange}
                    onBodyChange={onBodyChange}
                    onDelayChange={onDelayChange}
                    onSelectExport={onSelectExport}
                    onSend={onSend}
                    queues={queues}
                    selectedExportName={selectedExportName}
                    sending={sending}
                />
            )}
        </div>
    );
};

export default QueuesPanel;
