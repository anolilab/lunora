import { useLunora } from "@lunora/react";
import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import type { CapturedMail, CapturedMailResult, SendTestMailResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, copyToClipboard, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface MailPanelProps {
    /** Newest-N to load (default 100). */
    readonly limit?: number;
}

const CLEAR_CAPTURED_MAIL = adminRef(ADMIN_FUNCTIONS.clearCapturedMail);
const SEND_TEST_MAIL = adminRef(ADMIN_FUNCTIONS.sendTestMail);

/**
 * Matches the first `http(s)` URL in a body, stopping at whitespace, quotes, or
 * angle/closing brackets. Intentionally mirrors `@lunora/mail`'s `extractLink`
 * pattern (same char class) but is duplicated here rather than imported: the
 * studio bundle stays decoupled from the `@lunora/mail` runtime (it shares only
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

/** Captured mail whose subject or recipients contain `filter` (case-insensitive); everything when it is blank. */
const matchingMail = (entries: ReadonlyArray<CapturedMail>, filter: string): ReadonlyArray<CapturedMail> => {
    const needle = filter.trim().toLowerCase();

    if (needle === "") {
        return entries;
    }

    return entries.filter((entry) => `${entry.subject} ${recipientText(entry.to)}`.toLowerCase().includes(needle));
};

/** The selected message, defaulting to the newest visible one so a refresh or a filter change never leaves the detail pane pointing at nothing. */
const selectedMail = (visible: ReadonlyArray<CapturedMail>, selectedId: null | string): CapturedMail | undefined => {
    if (visible.length === 0) {
        return undefined;
    }

    return visible.find((entry) => entry.id === selectedId) ?? visible[0];
};

/**
 * Dev mail catcher — a unified inbox of every email the app sent. `@lunora/mail`'s
 * capture transport (wired in dev) intercepts each send and persists it to the
 * root-shard mailbox instead of delivering, so verification / forgot-password and
 * any app mail show up here with nothing leaving the machine. Reads the
 * `__lunora_admin__:getCapturedMail` RPC over the {@link useLunora} client;
 * gated by the server's `LUNORA_ADMIN_TOKEN`.
 *
 * The inbox is a single root-shard table with no write-flush to subscribe to, so
 * it polls on a fixed interval (paused while the tab is hidden) — new captured
 * mail appears without a manual refresh. The HTML body is rendered in a fully
 * sandboxed iframe (no script execution) so captured markup can't run in the studio.
 */
// react-doctor-disable-next-line react-doctor/no-giant-component -- ~424 lines. Decomposing this is a real refactor with its own review, not a lint fix — deferred deliberately, and recorded under "Deferred" in plans/README.md's Wave 15 so it is not invisible
const MailPanel = ({ limit = 100 }: MailPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    // The inbox is a single root-shard table with no write-flush to subscribe to,
    // so it's a one-shot read kept fresh by the poll below.
    const {
        data,
        error: readError,
        errorSource: readErrorSource,
        isLoading,
        refetch,
    } = useAdminQuery<CapturedMailResult>(ADMIN_FUNCTIONS.getCapturedMail, { limit });

    // Errors from the clear/send-test actions, surfaced alongside the read error.
    const [actionError, setActionError] = useState<null | string>(null);
    const [selectedId, setSelectedId] = useState<null | string>(null);
    const [tab, setTab] = useState<PreviewTab>("html");
    const [filter, setFilter] = useState<string>("");

    const entries: CapturedMail[] = data?.entries ?? [];
    const error = readError ?? actionError;
    // Prefer the read's raw error (carries hint/docsUrl); an action error is a plain message string.
    const errorSource = readError === null ? actionError : readErrorSource;

    const clearInbox = async (): Promise<void> => {
        setActionError(null);

        try {
            await client.query(CLEAR_CAPTURED_MAIL, {}, callOptions(""));
            setSelectedId(null);
            refetch();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }
    };

    const sendTest = async (): Promise<void> => {
        setActionError(null);

        try {
            (await client.query(SEND_TEST_MAIL, {}, callOptions(""))) as SendTestMailResult;
            refetch();
        } catch (error_) {
            setActionError(errorMessage(error_));
        }
    };

    // Poll for newly-captured mail so the inbox stays live without a manual refresh.
    useAutoRefresh(() => {
        refetch();
    }, true);

    const onClear = (): void => {
        fireAndForget(clearInbox());
    };

    const onSendTest = (): void => {
        fireAndForget(sendTest());
    };

    const onFilterChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.currentTarget.value);
    };

    const onSelectMessage = (event: MouseEvent<HTMLButtonElement>): void => {
        const { id } = event.currentTarget.dataset;

        if (id !== undefined) {
            setSelectedId(id);
        }
    };

    const onSelectTab = (event: MouseEvent<HTMLButtonElement>): void => {
        const next = event.currentTarget.dataset["tab"];

        if (next === "headers" || next === "html" || next === "text") {
            setTab(next);
        }
    };

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
    const visible = matchingMail(entries, filter);

    // Keep a valid selection across refreshes/filters: default to the newest visible message.
    const selected = selectedMail(visible, selectedId);

    // First actionable link in the selected message, for the copy / open buttons.
    const link = selectedLink(selected);

    const onCopyLink = (): void => {
        if (link !== undefined) {
            copyToClipboard(link);
        }
    };

    const onOpenLink = (): void => {
        if (link !== undefined && "window" in globalThis) {
            globalThis.window.open(link, "_blank", "noopener");
        }
    };

    return (
        <div className="flex flex-col gap-4" data-testid="mail-panel">
            <div className="flex flex-wrap items-center gap-2">
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

            {error !== null && <ErrorAlert error={errorSource} testId="mail-error" />}

            {error === null && !isLoading && entries.length === 0 && (
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
                        <ScrollArea className="max-h-[32rem] rounded-xl border border-border bg-card shadow-xs" data-testid="mail-list">
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
                        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs" data-testid="mail-detail">
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
