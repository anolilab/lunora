import type { MouseEvent, ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../../i18n/i18n-context";
import type { SavedQuery } from "../../lib/saved-queries";

/** Shared control-button class, matching the data browser's toolbar buttons. */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/**
 * The "name this query" input shown after Save query is clicked. Self-focuses on
 * mount via a ref (the a11y-friendly stand-in for `autoFocus`, matching the grid's
 * cell editor) and commits on the adjacent Save button. Local draft state so a
 * keystroke doesn't re-render the whole toolbar.
 */
const SaveQueryInput = ({ onCommit }: { onCommit: (name: string) => void }): ReactElement => {
    const t = useT();
    const [draft, setDraft] = useState<string>("");
    const ref = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        ref.current?.focus();
    }, []);

    const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setDraft(event.target.value);
    }, []);

    const commit = useCallback((): void => {
        const name = draft.trim();

        if (name !== "") {
            onCommit(name);
        }
    }, [draft, onCommit]);

    return (
        <span className="inline-flex items-center gap-1">
            <input
                aria-label={t("Query name")}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:border-ring"
                data-testid="db-save-query-name"
                onChange={onChange}
                placeholder={t("Query name")}
                ref={ref}
                value={draft}
            />
            <button className={CONTROL_BTN} data-testid="db-save-query-confirm" onClick={commit} type="button">
                {t("Save")}
            </button>
        </span>
    );
};

/**
 * The canned-query toolbar (Datasette's "every view is a shareable URL" + named
 * saved queries). Sits in the data browser's control bar with three affordances.
 * Copy link copies the current view's URL to the clipboard (the URL already
 * encodes table / tier / shard / filters / search / sort). Save query names the
 * current view and persists it to `localStorage`. Saved is a row of saved views;
 * selecting one applies it (the host navigates to its URL) and each has a delete.
 *
 * Pure markup + a little local input state; all persistence and navigation are the
 * host's (the Table editor owns the router and the `saved-queries` helper).
 */
const DataQueryBar = ({
    onApply,
    onCopyLink,
    onDelete,
    onSave,
    saved,
}: {
    /** Apply a saved view — the host navigates to its URL, which re-hydrates the browser. */
    onApply: (query: SavedQuery) => void;
    /** Copy the current view's shareable URL to the clipboard. */
    onCopyLink: () => void;
    /** Forget a saved view by name. */
    onDelete: (name: string) => void;
    /** Persist the current view under `name`. */
    onSave: (name: string) => void;
    /** The persisted saved views, most-recent first. */
    saved: ReadonlyArray<SavedQuery>;
}): ReactElement => {
    const t = useT();

    // Whether the inline "name this query" input is open.
    const [naming, setNaming] = useState<boolean>(false);

    const openNaming = useCallback((): void => {
        setNaming(true);
    }, []);

    const confirmSave = useCallback(
        (name: string): void => {
            onSave(name);
            setNaming(false);
        },
        [onSave],
    );

    // Apply a saved view by its position in the list (the dataset index keeps a
    // stable handler — no fresh closure per row).
    const applyByIndex = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const query = saved[Number(event.currentTarget.dataset["index"])];

            if (query !== undefined) {
                onApply(query);
            }
        },
        [onApply, saved],
    );

    const deleteByIndex = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const query = saved[Number(event.currentTarget.dataset["index"])];

            if (query !== undefined) {
                onDelete(query.name);
            }
        },
        [onDelete, saved],
    );

    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="db-query-bar">
            <button className={CONTROL_BTN} data-testid="db-copy-link" onClick={onCopyLink} type="button">
                {t("Copy link")}
            </button>

            {naming ? (
                <SaveQueryInput onCommit={confirmSave} />
            ) : (
                <button className={CONTROL_BTN} data-testid="db-save-query" onClick={openNaming} type="button">
                    {t("Save query")}
                </button>
            )}

            {saved.length > 0 && (
                <div className="flex flex-wrap items-center gap-1" data-testid="db-saved-queries">
                    <span className="text-xs font-medium text-muted-foreground">{t("Saved")}</span>
                    {saved.map((query, index) => (
                        <span className="inline-flex items-center overflow-hidden rounded-md border border-border" key={query.name}>
                            <button
                                className="px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent"
                                data-index={index}
                                data-testid={`db-saved-query-${query.name}`}
                                onClick={applyByIndex}
                                type="button"
                            >
                                {query.name}
                            </button>
                            <button
                                aria-label={t("Delete saved query {name}", { name: query.name })}
                                className="border-l border-border px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                data-index={index}
                                data-testid={`db-saved-query-delete-${query.name}`}
                                onClick={deleteByIndex}
                                type="button"
                            >
                                ✕
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

export default DataQueryBar;
