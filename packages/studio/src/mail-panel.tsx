import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CapturedMail, CapturedMailResult, SendTestMailResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { useT } from "./i18n-context";
import { adminRef, callOptions, copyToClipboard, errorMessage, fireAndForget, formatTimestamp } from "./internal";
import { useAutoRefresh } from "./use-auto-refresh";

interface MailPanelProps {
    /** Newest-N to load (default 100). */
    readonly limit?: number;
}

const GET_CAPTURED_MAIL = adminRef(ADMIN_FUNCTIONS.getCapturedMail);
const CLEAR_CAPTURED_MAIL = adminRef(ADMIN_FUNCTIONS.clearCapturedMail);
const SEND_TEST_MAIL = adminRef(ADMIN_FUNCTIONS.sendTestMail);

/**
 * Matches the first `http(s)` URL in a body, stopping at whitespace, quotes, or
 * angle/closing brackets. Intentionally mirrors `@cirrus/mail`'s `extractLink`
 * pattern (same char class) but is duplicated here rather than imported: the
 * studio bundle stays decoupled from the `@cirrus/mail` runtime (it shares only
 * plain strings/types with the server, never the package). Non-global because
 * the panel only needs the first link.
 */
const LINK_PATTERN = /https?:\/\/[^\s"'<>)]+/i;

/** First `http(s)` URL in `text`, or `undefined` when none — used to deep-link from a captured message. */
const firstLink = (text: string | undefined): string | undefined => {
    if (text === undefined) {
        return undefined;
    }

    const match = LINK_PATTERN.exec(text);

    return match?.[0];
};

/** The first link in a captured message: HTML body first, then the plain-text body. */
const selectedLink = (mail: CapturedMail | undefined): string | undefined => {
    if (mail === undefined) {
        return undefined;
    }

    return firstLink(mail.html) ?? firstLink(mail.text);
};

/** Which body of the selected message the preview pane shows. */
type PreviewTab = "headers" | "html" | "text";

/**
 * Restrictive CSP for the HTML preview: no scripts, no remote loads. `'none'`
 * blocks every fetch the sandbox would otherwise allow (images, CSS, fonts,
 * frames), with `data:` images and inline styles permitted since emails rely on
 * them. Prepended into the iframe document so a captured message can't fire a
 * tracking pixel when a developer opens it.
 */
const PREVIEW_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

/** Prepend the preview CSP meta so the sandboxed iframe makes no external requests. */
const withPreviewCsp = (html: string): string => `${PREVIEW_CSP}${html}`;

/** Join a recipient field (string or list) into one display string. */
const recipientText = (value: string | string[] | undefined): string => {
    if (value === undefined) {
        return "";
    }

    return Array.isArray(value) ? value.join(", ") : value;
};

/**
 * Dev mail catcher — a unified inbox of every email the app sent. `@cirrus/mail`'s
 * capture transport (wired in dev) intercepts each send and persists it to the
 * root-shard mailbox instead of delivering, so verification / forgot-password and
 * any app mail show up here with nothing leaving the machine. Reads the
 * `__cirrus_admin__:getCapturedMail` RPC over the {@link useCirrus} client;
 * gated by the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * A point-in-time read (the inbox is a single root-shard table): it fetches on
 * mount and on a manual refresh. The HTML body is rendered in a fully sandboxed
 * iframe (no script execution) so captured markup can't run in the studio.
 */
const MailPanel = ({ limit = 100 }: MailPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [entries, setEntries] = useState<CapturedMail[]>([]);
    const [error, setError] = useState<null | string>(null);
    const [selectedId, setSelectedId] = useState<null | string>(null);
    const [tab, setTab] = useState<PreviewTab>("html");
    const [filter, setFilter] = useState<string>("");

    const refresh = useCallback(async (): Promise<void> => {
        setError(null);

        try {
            const next = (await client.query(GET_CAPTURED_MAIL, { limit }, callOptions(""))) as CapturedMailResult;

            setEntries(next.entries);
        } catch (error_) {
            setEntries([]);
            setError(errorMessage(error_));
        }
    }, [client, limit]);

    const clearInbox = useCallback(async (): Promise<void> => {
        setError(null);

        try {
            await client.query(CLEAR_CAPTURED_MAIL, {}, callOptions(""));
            setSelectedId(null);
            await refresh();
        } catch (error_) {
            setError(errorMessage(error_));
        }
    }, [client, refresh]);

    const sendTest = useCallback(async (): Promise<void> => {
        setError(null);

        try {
            (await client.query(SEND_TEST_MAIL, {}, callOptions(""))) as SendTestMailResult;
            await refresh();
        } catch (error_) {
            setError(errorMessage(error_));
        }
    }, [client, refresh]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    // Poll for newly-captured mail so the inbox stays live without a manual refresh.
    useAutoRefresh(onRefresh, true);

    const onClear = useCallback((): void => {
        fireAndForget(clearInbox());
    }, [clearInbox]);

    const onSendTest = useCallback((): void => {
        fireAndForget(sendTest());
    }, [sendTest]);

    const onFilterChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.currentTarget.value);
    }, []);

    const onSelectMessage = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
        const { id } = event.currentTarget.dataset;

        if (id !== undefined) {
            setSelectedId(id);
        }
    }, []);

    const onSelectTab = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
        const next = event.currentTarget.dataset["tab"];

        if (next === "headers" || next === "html" || next === "text") {
            setTab(next);
        }
    }, []);

    const tabTitle = (value: PreviewTab): string => {
        if (value === "html") {
            return t("HTML");
        }

        if (value === "text") {
            return t("Plain text");
        }

        return t("Headers");
    };

    // Client-side substring filter over subject + recipient, AND-combined with the
    // server-loaded window. An empty query passes everything through unchanged.
    const visible = useMemo<CapturedMail[]>(() => {
        const needle = filter.trim().toLowerCase();

        if (needle === "") {
            return entries;
        }

        return entries.filter((entry) => `${entry.subject} ${recipientText(entry.to)}`.toLowerCase().includes(needle));
    }, [entries, filter]);

    // Keep a valid selection across refreshes/filters: default to the newest visible message.
    const selected = useMemo<CapturedMail | undefined>(() => {
        if (visible.length === 0) {
            return undefined;
        }

        return visible.find((entry) => entry.id === selectedId) ?? visible[0];
    }, [visible, selectedId]);

    // First actionable link in the selected message, for the copy / open buttons.
    const link = useMemo<string | undefined>(() => selectedLink(selected), [selected]);

    const onCopyLink = useCallback((): void => {
        if (link !== undefined) {
            copyToClipboard(link);
        }
    }, [link]);

    const onOpenLink = useCallback((): void => {
        if (link !== undefined && "window" in globalThis) {
            globalThis.window.open(link, "_blank", "noopener");
        }
    }, [link]);

    return (
        <div className="flex flex-col gap-4" data-testid="mail-panel">
            <div className="flex flex-wrap items-center gap-2">
                <Button data-testid="mail-refresh" onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <Button data-testid="mail-send-test" onClick={onSendTest} size="sm" type="button" variant="outline">
                    {t("Send test")}
                </Button>
                <Button data-testid="mail-clear" disabled={entries.length === 0} onClick={onClear} size="sm" type="button" variant="outline">
                    {t("Clear inbox")}
                </Button>
                {entries.length > 0 && (
                    <Badge className="ml-auto" data-testid="mail-count" variant="secondary">
                        {t("{count} messages", { count: entries.length })}
                    </Badge>
                )}
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="mail-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && entries.length === 0 && (
                <EmptyState
                    description={t("Email your app sends in dev is captured here — nothing is delivered.")}
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
                            <path d="M4 5h16v14H4z" />
                            <path d="m4 6 8 6 8-6" />
                        </svg>
                    }
                    testId="mail-empty"
                    title={t("No captured email.")}
                />
            )}

            {entries.length > 0 && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,22rem)_1fr]" data-testid="mail-reader">
                    <div className="flex flex-col gap-2">
                        <Input
                            aria-label={t("Search messages")}
                            data-testid="mail-search"
                            onChange={onFilterChange}
                            placeholder={t("Filter messages")}
                            type="search"
                            value={filter}
                        />
                        <ScrollArea className="max-h-[32rem] rounded-md border" data-testid="mail-list">
                            <ul className="divide-y">
                                {visible.map((entry) => {
                                    const isActive = entry.id === selected?.id;

                                    return (
                                        <li key={entry.id}>
                                            <button
                                                className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted/60 ${isActive ? "bg-muted" : ""}`}
                                                data-active={isActive}
                                                data-id={entry.id}
                                                data-testid="mail-list-item"
                                                onClick={onSelectMessage}
                                                type="button"
                                            >
                                                <span className="w-full truncate font-medium">{entry.subject || t("(no subject)")}</span>
                                                <span className="w-full truncate text-xs text-muted-foreground">{recipientText(entry.to)}</span>
                                                <span className="text-xs text-muted-foreground tabular-nums">{formatTimestamp(entry.capturedAt, "—")}</span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </ScrollArea>
                    </div>

                    {selected !== undefined && (
                        <div className="flex min-w-0 flex-col gap-3 rounded-md border p-4" data-testid="mail-detail">
                            <div className="flex flex-col gap-1">
                                <h2 className="truncate text-base font-semibold" data-testid="mail-subject">
                                    {selected.subject || t("(no subject)")}
                                </h2>
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    <dt>{t("From")}</dt>
                                    <dd className="truncate font-mono">{selected.from ?? "—"}</dd>
                                    <dt>{t("To")}</dt>
                                    <dd className="truncate font-mono">{recipientText(selected.to)}</dd>
                                    {selected.cc !== undefined && selected.cc.length > 0 && (
                                        <>
                                            <dt>{t("Cc")}</dt>
                                            <dd className="truncate font-mono">{recipientText(selected.cc)}</dd>
                                        </>
                                    )}
                                    <dt>{t("Sent")}</dt>
                                    <dd className="tabular-nums">{formatTimestamp(selected.capturedAt, "—")}</dd>
                                </dl>
                            </div>

                            <div className="flex flex-wrap items-center gap-2" data-testid="mail-actions">
                                <Button
                                    data-testid="mail-copy-link"
                                    disabled={link === undefined}
                                    onClick={onCopyLink}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    {t("Copy link")}
                                </Button>
                                <Button
                                    data-testid="mail-open-link"
                                    disabled={link === undefined}
                                    onClick={onOpenLink}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    {t("Open in new tab")}
                                </Button>
                            </div>

                            <Separator />

                            <div className="flex items-center gap-1" data-testid="mail-tabs" role="tablist">
                                {(["html", "text", "headers"] as const).map((value) => (
                                    <Button
                                        aria-selected={tab === value}
                                        data-tab={value}
                                        data-testid={`mail-tab-${value}`}
                                        key={value}
                                        onClick={onSelectTab}
                                        role="tab"
                                        size="sm"
                                        type="button"
                                        variant={tab === value ? "secondary" : "ghost"}
                                    >
                                        {tabTitle(value)}
                                    </Button>
                                ))}
                            </div>

                            <div className="min-h-[12rem]">
                                {tab === "html" &&
                                    (selected.html === undefined ? (
                                        <p className="text-sm text-muted-foreground">{t("No HTML body.")}</p>
                                    ) : (
                                        // Fully sandboxed (no `allow-scripts`): captured markup renders but
                                        // cannot execute in the studio. A restrictive CSP additionally blocks
                                        // remote resource loads (tracking pixels / `@import`) so opening a
                                        // captured message can't phone home — only inline styles + data: images.
                                        <iframe
                                            className="h-[24rem] w-full rounded-md border bg-white"
                                            data-testid="mail-preview-html"
                                            sandbox=""
                                            srcDoc={withPreviewCsp(selected.html)}
                                            title={t("Email preview")}
                                        />
                                    ))}
                                {tab === "text" &&
                                    (selected.text === undefined ? (
                                        <p className="text-sm text-muted-foreground">{t("No text body.")}</p>
                                    ) : (
                                        <pre
                                            className="overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs"
                                            data-testid="mail-preview-text"
                                        >
                                            {selected.text}
                                        </pre>
                                    ))}
                                {tab === "headers" &&
                                    (selected.headers === undefined || Object.keys(selected.headers).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{t("No headers.")}</p>
                                    ) : (
                                        <pre
                                            className="overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs"
                                            data-testid="mail-preview-headers"
                                        >
                                            {Object.entries(selected.headers)
                                                .map(([name, value]) => `${name}: ${value}`)
                                                .join("\n")}
                                        </pre>
                                    ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export { MailPanel };
export type { MailPanelProps };
