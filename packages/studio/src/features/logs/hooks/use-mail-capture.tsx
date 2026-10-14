import { useLunora } from "@lunora/react";
import type { ChangeEvent, MouseEvent } from "react";
import { useState } from "react";

import { useAdminQuery } from "../../../hooks/use-admin-query";
import { useAutoRefresh } from "../../../hooks/use-auto-refresh";
import type { CapturedMail, CapturedMailResult, SendTestMailResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, copyToClipboard, errorMessage, fireAndForget } from "../../../lib/internal";
import { matchingMail, selectedLink, selectedMail } from "../mail-selection";

const CLEAR_CAPTURED_MAIL = adminRef(ADMIN_FUNCTIONS.clearCapturedMail);
const SEND_TEST_MAIL = adminRef(ADMIN_FUNCTIONS.sendTestMail);

/** Which rendering of the selected message the preview shows. */
type PreviewTab = "headers" | "html" | "text";

/** Everything the mail panel needs that is not copy: the inbox model plus its controls. */
interface MailCapture {
    entries: CapturedMail[];
    error: null | string;
    errorSource: unknown;
    filter: string;
    isLoading: boolean;
    link: string | undefined;
    onClear: () => void;
    onCopyLink: () => void;
    onFilterChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onOpenLink: () => void;
    onSelectMessage: (event: MouseEvent<HTMLButtonElement>) => void;
    onSelectTab: (event: MouseEvent<HTMLButtonElement>) => void;
    onSendTest: () => void;
    selected: CapturedMail | undefined;
    tab: PreviewTab;
    visible: ReadonlyArray<CapturedMail>;
}

/**
 * The dev mail-catcher's inbox: the captured-mail read and its poll, the
 * clear / send-test actions, and the selection + filter + preview-tab state the
 * panel drives.
 *
 * Extracted from the panel so the component is markup and copy only — the same
 * split `useDataBrowser` and `useFileBrowser` already use. Nothing here is
 * presentational, so it is unit-testable without a renderer.
 */
const useMailCapture = ({ limit }: { limit: number }): MailCapture => {
    const client = useLunora();

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

    return {
        entries,
        error,
        errorSource,
        filter,
        isLoading,
        link,
        onClear,
        onCopyLink,
        onFilterChange,
        onOpenLink,
        onSelectMessage,
        onSelectTab,
        onSendTest,
        selected,
        tab,
        visible,
    };
};

export { useMailCapture };
export type { MailCapture, PreviewTab };
