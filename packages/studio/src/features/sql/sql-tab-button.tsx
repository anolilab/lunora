import type { FocusEvent, KeyboardEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import type { SqlTab } from "./sql-tabs";
import { isDirty } from "./sql-tabs";

/** The auto-derived tab label when the operator hasn't set a custom name: the draft's first line, or "Untitled". */
const derivedTabLabel = (sql: string, untitled: string): string => (sql.trim() === "" ? untitled : (sql.split("\n")[0] ?? sql).slice(0, 24));

/** Focus and select the rename input the moment it mounts, so typing replaces the old name. */
const focusOnMount = (node: HTMLInputElement | null): void => {
    node?.focus();
    node?.select();
};

/** The inline rename editor shown in place of the tab label; commits on Enter/blur, cancels on Esc. */
const TabRenameInput = ({
    initial,
    onCancel,
    onCommit,
    placeholder,
    testId,
}: {
    initial: string;
    onCancel: () => void;
    onCommit: (name: string) => void;
    placeholder: string;
    testId: string;
}): ReactElement => {
    const t = useT();
    // Callback ref: focus + select the moment it mounts (fires once on open, not per render).
    const onBlur = (event: FocusEvent<HTMLInputElement>): void => {
        onCommit(event.currentTarget.value.trim());
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            onCommit(event.currentTarget.value.trim());
        } else if (event.key === "Escape") {
            onCancel();
        }
    };

    return (
        <input
            aria-label={t("Tab title")}
            className="w-40 rounded border border-ring bg-background px-1 py-0.5 text-xs outline-none"
            data-testid={testId}
            defaultValue={initial}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            ref={focusOnMount}
            type="text"
        />
    );
};

/** The inline "Discard? ✓ ✕" prompt shown in place of the close button when a dirty tab is being closed. */
const TabCloseConfirm = ({
    idBase,
    onDiscard,
    onKeep,
}: {
    idBase: string;
    onDiscard: (event: MouseEvent<HTMLButtonElement>) => void;
    onKeep: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactElement => {
    const t = useT();

    return (
        <span className="flex shrink-0 items-center gap-1" data-testid={`sql-tab-close-prompt-${idBase}`} role="group">
            <span className="text-[11px] text-muted-foreground">{t("Discard?")}</span>
            <button
                aria-label={t("Discard changes")}
                className="flex size-5 items-center justify-center rounded text-destructive hover:bg-destructive/10"
                data-testid={`sql-tab-close-confirm-${idBase}`}
                onClick={onDiscard}
                title={t("Discard changes")}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.4}
                    viewBox="0 0 24 24"
                >
                    <path d="M5 13l4 4L19 7" />
                </svg>
            </button>
            <button
                aria-label={t("Keep editing")}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                data-testid={`sql-tab-close-cancel-${idBase}`}
                onClick={onKeep}
                title={t("Keep editing")}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.4}
                    viewBox="0 0 24 24"
                >
                    <path d="M6 6l12 12M18 6 6 18" />
                </svg>
            </button>
        </span>
    );
};

interface TabButtonProps {
    readonly active: boolean;
    readonly canClose: boolean;
    readonly onClose: (id: string) => void;
    readonly onMenu: (id: string, event: MouseEvent) => void;
    readonly onRename: (id: string, name: string) => void;
    readonly onSelect: (id: string) => void;
    readonly tab: SqlTab;
}

/**
 * One editor tab in the strip: a label that selects it (double-click to rename it
 * in place) plus a close affordance (hidden for the sole tab). The label is the
 * operator's custom `tab.name` when set, else a preview derived from the draft.
 * Closing an unlinked draft with text first asks to confirm the discard.
 */
const TabButton = ({ active, canClose, onClose, onMenu, onRename, onSelect, tab }: TabButtonProps): ReactElement => {
    const t = useT();
    const [editing, setEditing] = useState<boolean>(false);
    const [confirmingClose, setConfirmingClose] = useState<boolean>(false);

    const onContextMenu = (event: MouseEvent): void => {
        onMenu(tab.id, event);
    };
    const onClick = (): void => {
        onSelect(tab.id);
    };
    const startEditing = (): void => {
        setEditing(true);
    };

    const onCloseClick = (event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();

        // Guard an unsaved draft behind the inline confirm; close the rest outright.
        if (isDirty(tab)) {
            setConfirmingClose(true);
        } else {
            onClose(tab.id);
        }
    };
    const confirmClose = (event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        setConfirmingClose(false);
        onClose(tab.id);
    };
    const cancelClose = (event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        setConfirmingClose(false);
    };

    // Commit the edited title (trimmed; blank reverts the tab to its derived label).
    const commitRename = (name: string): void => {
        onRename(tab.id, name);
        setEditing(false);
    };
    const cancelRename = (): void => {
        setEditing(false);
    };

    const custom = tab.name.trim();
    const derived = derivedTabLabel(tab.sql, t("Untitled"));

    return (
        <div
            className={cn(
                "group/tab flex shrink-0 items-center gap-1 border-e border-border ps-3 pe-1.5 text-xs",
                active ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
            data-testid={`sql-tab-${tab.id}`}
            onContextMenu={onContextMenu}
        >
            {editing ? (
                <TabRenameInput initial={custom} onCancel={cancelRename} onCommit={commitRename} placeholder={derived} testId={`sql-tab-rename-${tab.id}`} />
            ) : (
                <button
                    aria-pressed={active}
                    className="max-w-40 truncate py-1.5 outline-none"
                    data-testid={`sql-tab-select-${tab.id}`}
                    onClick={onClick}
                    onDoubleClick={startEditing}
                    title={t("Double-click to rename")}
                    type="button"
                >
                    {custom === "" ? derived : custom}
                </button>
            )}
            {canClose &&
                (confirmingClose ? (
                    <TabCloseConfirm idBase={tab.id} onDiscard={confirmClose} onKeep={cancelClose} />
                ) : (
                    <button
                        aria-label={t("Close tab")}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        data-testid={`sql-tab-close-${tab.id}`}
                        onClick={onCloseClick}
                        title={t("Close tab")}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-3"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                        >
                            <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                    </button>
                ))}
        </div>
    );
};

export default TabButton;
