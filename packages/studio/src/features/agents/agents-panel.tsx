import type { ReactElement } from "react";
import { useState } from "react";

import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { TableInfo, TablePage } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

interface AgentsPanelProps {
    /** Shard the reads target. Empty string → the root shard. */
    readonly initialShardKey?: string;
}

/** The merged agent schema-extension table names the runtime reads/writes (see `@lunora/agent`'s `component.ts`). */
const THREADS_TABLE = "agent_threads";
const MESSAGES_TABLE = "agent_messages";

/** Read caps — a studio observability view, not a paginated browser (the data browser owns deep paging). */
const THREAD_LIMIT = 100;
const MESSAGE_LIMIT = 250;

/** Stable empty args for the no-argument `listTables` presence probe (avoids a fresh object each render). */
const NO_ARGS: Record<string, unknown> = {};

/** The threads read never varies — newest-first, capped, no COUNT — so it's a module constant (stable reference). */
const THREADS_ARGS: Record<string, unknown> = {
    filters: [],
    limit: THREAD_LIMIT,
    offset: 0,
    orderBy: { column: "updatedAt", direction: "desc" },
    skipCount: true,
    table: THREADS_TABLE,
};

/** Read a string column off a loosely-typed admin row, or `undefined` when absent / wrong type. */
const readString = (row: Record<string, unknown>, key: string): string | undefined => {
    const value = row[key];

    return typeof value === "string" ? value : undefined;
};

/** Read a numeric column off a loosely-typed admin row, or `undefined` when absent / wrong type. */
const readNumber = (row: Record<string, unknown>, key: string): number | undefined => {
    const value = row[key];

    return typeof value === "number" ? value : undefined;
};

/** The persisted per-run token usage on a thread row (`@lunora/agent`'s `usage` column), read defensively. */
const readTotalTokens = (row: Record<string, unknown>): number | undefined => {
    const { usage } = row;

    if (usage === null || typeof usage !== "object") {
        return undefined;
    }

    const { totalTokens } = usage as Record<string, unknown>;

    return typeof totalTokens === "number" ? totalTokens : undefined;
};

/** The tool names an assistant turn invoked (`toolCalls[].name`), read defensively off a message row. */
const readToolNames = (row: Record<string, unknown>): string[] => {
    const { toolCalls } = row;

    if (!Array.isArray(toolCalls)) {
        return [];
    }

    return toolCalls
        .map((call) => (call !== null && typeof call === "object" ? (call as Record<string, unknown>).name : undefined))
        .filter((name): name is string => typeof name === "string");
};

/** Map a thread lifecycle status to a semantic badge variant. */
const threadStatusVariant = (status: string | undefined): "destructive" | "info" | "outline" | "success" | "warning" => {
    switch (status) {
        case "awaiting_input": {
            return "warning";
        }
        case "cancelled": {
            return "warning";
        }
        case "error": {
            return "destructive";
        }
        case "running": {
            return "info";
        }
        default: {
            return "outline";
        }
    }
};

/** Map a message approval marker to a semantic badge variant. */
const approvalVariant = (status: string): "destructive" | "success" | "warning" => {
    switch (status) {
        case "approved": {
            return "success";
        }
        case "rejected": {
            return "destructive";
        }
        default: {
            return "warning";
        }
    }
};

/**
 * The Agents inspector — a read-only observability view over `@lunora/agent`'s
 * durable threads. It reads the agent schema-extension tables (`agent_threads` /
 * `agent_messages`) through the studio's existing admin data-access path
 * (`__lunora_admin__:readTablePage`), so it needs no agent-specific RPC: the
 * threads list, per-thread message timeline (assistant/tool messages, tool
 * calls, approval state), and per-run token usage all come from those two tables.
 *
 * Approvals are surfaced read-only — they're resolved from the app's client hooks
 * (`useAgentChat`), not the studio. The reads are live (they stream over the
 * admin subscription), so a running agent's timeline fills in without a refresh.
 */
const AgentsPanel = ({ initialShardKey = "" }: AgentsPanelProps): ReactElement => {
    const t = useT();

    const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

    // Presence probe: the agent tables only exist when the app declares agents and
    // merges the schema extension, so a bare `readTablePage` on a missing table
    // would error. Gate every read on the table showing up in `listTables`.
    const { data: tables } = useAdminQuery<TableInfo[]>(ADMIN_FUNCTIONS.listTables, NO_ARGS, { live: true, shardKey: initialShardKey });

    const loadedTables = tables !== undefined;
    const hasAgentTables = Array.isArray(tables) && tables.some((table) => table.name === THREADS_TABLE);

    const {
        data: threadsPage,
        error: threadsError,
        errorSource: threadsErrorSource,
        liveError: threadsLiveError,
    } = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, THREADS_ARGS, { enabled: hasAgentTables, live: true, shardKey: initialShardKey });

    const messagesArgs: Record<string, unknown> = {
        filters: [{ column: "threadKey", operator: "eq", value: selectedKey ?? "" }],
        limit: MESSAGE_LIMIT,
        offset: 0,
        orderBy: { column: "seq", direction: "asc" },
        skipCount: true,
        table: MESSAGES_TABLE,
    };

    const {
        data: messagesPage,
        error: messagesError,
        errorSource: messagesErrorSource,
    } = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, messagesArgs, {
        enabled: hasAgentTables && selectedKey !== undefined,
        live: true,
        shardKey: initialShardKey,
    });

    const threads = Array.isArray(threadsPage?.rows) ? threadsPage.rows : [];
    const messages = Array.isArray(messagesPage?.rows) ? messagesPage.rows : [];

    const selectedThread = threads.find((row) => readString(row, "key") === selectedKey);

    let body: ReactElement;

    if (loadedTables && !hasAgentTables) {
        body = (
            <EmptyState
                description={t(
                    "No @lunora/agent tables found in this deployment. Add lunora/agents.ts with defineAgent(...) and merge the agent schema extension to run durable AI agents.",
                )}
                testId="agents-unconfigured"
                title={t("No agents configured")}
            />
        );
    } else if (hasAgentTables && threads.length === 0) {
        body = (
            <EmptyState
                description={t("No agent has run yet. Start a run with ctx.agents.<name>.run(...) and its thread appears here.")}
                testId="agents-empty"
                title={t("No agent threads yet")}
            />
        );
    } else {
        body = (
            <div className="flex flex-col gap-6">
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="agents-threads-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Agent")}</TableHead>
                                    <TableHead>{t("Key")}</TableHead>
                                    <TableHead>{t("Status")}</TableHead>
                                    <TableHead>{t("Messages")}</TableHead>
                                    <TableHead>{t("Tokens")}</TableHead>
                                    <TableHead>{t("Updated")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {threads.map((row) => {
                                    const key = readString(row, "key") ?? "";
                                    const status = readString(row, "status");
                                    const totalTokens = readTotalTokens(row);

                                    return (
                                        <TableRow data-active={key === selectedKey ? "" : undefined} data-testid={`agents-thread-${key}`} key={key}>
                                            <TableCell className="font-mono text-xs">{readString(row, "agent") ?? "—"}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{key}</TableCell>
                                            <TableCell>
                                                <Badge data-testid={`agents-thread-status-${key}`} variant={threadStatusVariant(status)}>
                                                    {status ?? "—"}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="tabular-nums">{readNumber(row, "messageCount") ?? "—"}</TableCell>
                                            <TableCell className="tabular-nums text-muted-foreground">{totalTokens ?? "—"}</TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">
                                                {formatTimestamp(readNumber(row, "updatedAt"), "—")}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Button
                                                    data-testid={`agents-thread-open-${key}`}
                                                    onClick={(): void => {
                                                        setSelectedKey(key);
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="outline"
                                                >
                                                    {t("Timeline")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>

                {messagesError !== null && <ErrorAlert error={messagesErrorSource} testId="agents-messages-error" />}

                {selectedKey !== undefined && (
                    <Card className="overflow-hidden py-0" data-testid="agents-thread-detail">
                        <CardContent className="flex flex-col gap-3 px-4 py-3">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-xs">
                                    {t("Timeline")} · {selectedKey}
                                    {selectedThread !== undefined && (
                                        <span className="text-muted-foreground">
                                            {" · "}
                                            {t("Usage")}: {readTotalTokens(selectedThread) ?? 0} {t("Tokens")}
                                        </span>
                                    )}
                                </span>
                                <Button
                                    data-testid="agents-thread-detail-close"
                                    onClick={(): void => {
                                        setSelectedKey(undefined);
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t("Close")}
                                </Button>
                            </div>

                            {messages.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t("This thread has no messages yet.")}</p>
                            ) : (
                                <Table data-testid="agents-messages-table">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("Role")}</TableHead>
                                            <TableHead>{t("Content")}</TableHead>
                                            <TableHead>{t("Tool")}</TableHead>
                                            <TableHead>{t("Approval")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {messages.map((row, index) => {
                                            const role = readString(row, "role") ?? "—";
                                            const toolNames = readToolNames(row);
                                            const toolName = readString(row, "toolName");
                                            const approval = readString(row, "status");
                                            const seq = readNumber(row, "seq") ?? index;

                                            return (
                                                <TableRow
                                                    data-testid={`agents-message-${String(seq)}`}
                                                    key={readString(row, "messageKey") ?? `${role}:${String(seq)}`}
                                                >
                                                    <TableCell className="font-mono text-xs align-top text-muted-foreground">{role}</TableCell>
                                                    <TableCell className="max-w-md font-mono text-xs whitespace-pre-wrap break-words">
                                                        {readString(row, "content") ?? "—"}
                                                    </TableCell>
                                                    <TableCell className="font-mono text-xs align-top text-muted-foreground">
                                                        {toolName ?? (toolNames.length > 0 ? toolNames.join(", ") : "—")}
                                                    </TableCell>
                                                    <TableCell className="align-top">
                                                        {approval === undefined ? (
                                                            <span className="text-xs text-muted-foreground">—</span>
                                                        ) : (
                                                            <Badge data-testid={`agents-message-approval-${String(seq)}`} variant={approvalVariant(approval)}>
                                                                {approval}
                                                            </Badge>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-agents-panel">
            {threadsError !== null && <ErrorAlert error={threadsErrorSource} testId="agents-error" />}

            <p className="text-sm text-muted-foreground">
                {t(
                    "Agents run as durable workflows. Each run persists a thread of assistant and tool messages; select a thread to inspect its timeline, tool calls, approvals, and token usage.",
                )}
            </p>

            {threadsLiveError !== undefined && (
                <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="agents-live-error" role="alert">
                    {t("Live updates unavailable; showing the last evaluation.")}
                </p>
            )}

            {body}
        </div>
    );
};

export default AgentsPanel;
