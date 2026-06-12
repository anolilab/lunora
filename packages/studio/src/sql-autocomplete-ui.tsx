import type { ReactElement, RefObject } from "react";
import { useCallback, useMemo, useState } from "react";

import { useT } from "./i18n-context";
import { cn } from "./lib/utils";
import type { SqlSchema, Suggestion } from "./sql-autocomplete";
import { acceptSuggestion, suggestionsFor } from "./sql-autocomplete";

/**
 * The open autocomplete session: the candidates for the token under the caret
 * plus which one is highlighted. `null` when nothing is offered (no token, or
 * the operator dismissed the popover with Esc).
 */
interface AutocompleteState {
    readonly active: number;
    readonly suggestions: ReadonlyArray<Suggestion>;
}

/** What {@link useSqlAutocomplete} returns: the popover state + the handlers the textarea wires up. */
interface SqlAutocomplete {
    /** Close the popover (Esc, blur, or after an accept). */
    readonly close: () => void;
    /** Apply the highlighted suggestion into the editor text; returns whether one was applied. */
    readonly commit: () => boolean;
    /** Re-derive suggestions from the current caret/value (call on change + caret moves). */
    readonly refresh: (value: string, caret: number) => void;
    /** The popover's listbox state, or `null` when closed. */
    readonly state: AutocompleteState | null;
}

/**
 * Drive a schema-aware completion popover over the SQL editor's textarea.
 * Stateless beyond the open session: it derives candidates from `schema` (the
 * tables + columns the editor already loaded from admin RPCs) on each
 * {@link SqlAutocomplete.refresh}, and {@link SqlAutocomplete.commit} splices the
 * highlighted one back through `setValue` while re-focusing the textarea and
 * restoring the caret. The keyboard navigation (↑/↓/Enter/Tab/Esc) lives in the
 * panel's keydown handler, which reads `move`/`commit`/`close` off the returned object.
 */
const useSqlAutocomplete = (
    schema: SqlSchema,
    textareaRef: RefObject<HTMLTextAreaElement | null>,
    setValue: (value: string) => void,
): SqlAutocomplete & { move: (delta: number) => void } => {
    const [state, setState] = useState<AutocompleteState | null>(null);

    const refresh = useCallback(
        (value: string, caret: number): void => {
            const suggestions = suggestionsFor(value, caret, schema);

            setState(suggestions.length === 0 ? null : { active: 0, suggestions });
        },
        [schema],
    );

    const close = useCallback((): void => {
        setState(null);
    }, []);

    const move = useCallback((delta: number): void => {
        setState((current) => {
            if (current === null) {
                return current;
            }

            const count = current.suggestions.length;
            const active = (current.active + delta + count) % count;

            return { active, suggestions: current.suggestions };
        });
    }, []);

    const commit = useCallback((): boolean => {
        const textarea = textareaRef.current;

        if (state === null || textarea === null) {
            return false;
        }

        const chosen = state.suggestions[state.active];

        if (chosen === undefined) {
            return false;
        }

        const next = acceptSuggestion(textarea.value, textarea.selectionStart, chosen);

        setValue(next.value);
        setState(null);

        // Restore focus + caret after React re-renders the controlled value.
        requestAnimationFrame(() => {
            const node = textareaRef.current;

            if (node !== null) {
                node.focus();
                node.setSelectionRange(next.caret, next.caret);
            }
        });

        return true;
    }, [setValue, state, textareaRef]);

    return useMemo(() => {
        return { close, commit, move, refresh, state };
    }, [close, commit, move, refresh, state]);
};

interface AutocompletePopoverProps {
    /** The id of the listbox, so the textarea can own `aria-controls`/`aria-activedescendant`. */
    readonly listboxId: string;
    /** Apply the suggestion at `index` (mouse path mirrors the keyboard commit). */
    readonly onPick: (index: number) => void;
    readonly state: AutocompleteState | null;
}

/** Localized noun per suggestion kind, shown as a muted trailing badge. */
const KIND_LABEL = { column: "column", keyword: "keyword", table: "table" } as const;

/**
 * The completion list rendered beneath the editor. An ARIA `listbox` whose
 * options the textarea references via `aria-activedescendant`, so a screen
 * reader announces the highlighted candidate as the operator arrows through it.
 * Mouse hover/click mirror the keyboard path. Renders nothing when closed.
 */
const AutocompletePopover = ({ listboxId, onPick, state }: AutocompletePopoverProps): null | ReactElement => {
    const t = useT();

    if (state === null) {
        return null;
    }

    return (
        <ul
            className="absolute start-0 top-full z-20 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
            data-testid="sql-autocomplete"
            id={listboxId}
            role="listbox"
        >
            {state.suggestions.map((suggestion, index) => (
                <li
                    aria-selected={index === state.active}
                    className={cn(
                        "flex cursor-pointer items-center gap-2 px-2 py-1 text-[13px]",
                        index === state.active ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                    data-testid="sql-autocomplete-item"
                    id={`${listboxId}-opt-${index.toString()}`}
                    key={`${suggestion.kind}:${suggestion.label}`}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-option mouse-pick closes over its index; small admin popover render path
                    onMouseDown={(event) => {
                        // Pick on mousedown (before the textarea blurs) so the click lands.
                        event.preventDefault();
                        onPick(index);
                    }}
                    role="option"
                >
                    <span className="truncate font-mono">{suggestion.label}</span>
                    {suggestion.detail !== undefined && <span className="ms-auto truncate text-xs text-muted-foreground">{suggestion.detail}</span>}
                    <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70 uppercase">{t(KIND_LABEL[suggestion.kind])}</span>
                </li>
            ))}
        </ul>
    );
};

export { AutocompletePopover, useSqlAutocomplete };
export type { SqlAutocomplete };
