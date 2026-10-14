import type { ReactElement, RefObject } from "react";
import { useCallback, useState } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import type { SqlSchema, Suggestion } from "./sql-autocomplete";
import { acceptSuggestion, suggestionsFor } from "./sql-autocomplete";

/**
 * The open autocomplete session: the candidates for the token under the caret
 * plus which one is highlighted, and the caret's pixel offset within the
 * textarea so the popover can float over the text right at the caret rather than
 * pinned to the bottom of the editor. `null` when nothing is offered (no token,
 * or the operator dismissed the popover with Esc).
 */
interface AutocompleteState {
    readonly active: number;
    /** Caret x offset (px) from the textarea's left padding edge, scroll-adjusted. */
    readonly left: number;
    readonly suggestions: ReadonlyArray<Suggestion>;
    /** Caret y offset (px) from the textarea's top padding edge, scroll-adjusted. */
    readonly top: number;
}

/**
 * The textarea-mirror copied style props: everything that affects where a glyph
 * lands, so the hidden mirror wraps text identically to the real textarea.
 */
const MIRROR_PROPS = [
    "boxSizing",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderRightWidth",
    "borderTopWidth",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "tabSize",
    "textIndent",
    "textTransform",
    "width",
    "wordSpacing",
] as const;

/**
 * Pixel offset of the caret within a textarea, using the well-known hidden-mirror
 * technique: clone the textarea's text-layout styles into an off-screen div, fill
 * it with the text up to the caret, and measure a marker span at the boundary.
 * Returns `{ left, top }` relative to the textarea's padding box, scroll-adjusted.
 * Under jsdom (no layout) the offsets read 0 — the popover then sits at the
 * editor's top-left, which is fine for tests.
 */
const caretOffset = (textarea: HTMLTextAreaElement, caret: number): { left: number; top: number } => {
    const computed = globalThis.getComputedStyle(textarea);
    const mirror = globalThis.document.createElement("div");
    const { style } = mirror;

    style.position = "absolute";
    style.visibility = "hidden";
    style.whiteSpace = "pre-wrap";
    style.overflowWrap = "break-word";

    for (const property of MIRROR_PROPS) {
        style[property] = computed[property];
    }

    mirror.textContent = textarea.value.slice(0, Math.max(0, caret));

    const marker = globalThis.document.createElement("span");

    // A non-empty marker so it has a box to measure even at the very end of the text.
    marker.textContent = textarea.value.slice(Math.max(0, caret)) || ".";
    mirror.append(marker);
    globalThis.document.body.append(mirror);

    const left = marker.offsetLeft - textarea.scrollLeft;
    const top = marker.offsetTop - textarea.scrollTop;

    mirror.remove();

    return { left, top };
};

/** What {@link useSqlAutocomplete} returns: the popover state + the handlers the textarea wires up. */
interface SqlAutocomplete {
    /** Close the popover (Esc, blur, or after an accept). */
    readonly close: () => void;
    /** Apply the highlighted suggestion into the editor text; returns whether one was applied. */
    readonly commit: () => boolean;
    /** Apply the suggestion at `index` (the mouse path) — see the implementation for why this can't go through `move`. */
    readonly commitAt: (index: number) => boolean;
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

    // Stable across renders (only re-created when the schema data changes) so the
    // panel's "re-derive once a probe resolves" effect keys off it without firing
    // after every render. The functional setState bails to the CURRENT state when
    // the derived session is unchanged — without that bail, a refresh from an
    // effect would loop forever: fresh state object → re-render → effect →
    // refresh → fresh state object … (the studio's SQL-editor render-loop hang).
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: `refresh` is a dependency of the probe-refresh effect; a stable identity is what stops that effect firing every render (the render-loop hang described above). React Compiler would memoize it in the build, but the vitest suite runs the JSX through esbuild without the compiler transform, so the explicit useCallback is what holds the identity stable in the tests that now gate CI.
    const refresh = useCallback(
        (value: string, caret: number): void => {
            const suggestions = suggestionsFor(value, caret, schema);

            if (suggestions.length === 0) {
                setState(null);

                return;
            }

            const node = textareaRef.current;
            const { left, top } = node === null ? { left: 0, top: 0 } : caretOffset(node, caret);

            setState((current) => {
                const unchanged =
                    current !== null &&
                    current.active === 0 &&
                    current.left === left &&
                    current.top === top &&
                    current.suggestions.length === suggestions.length &&
                    current.suggestions.every((existing, index) => {
                        const next = suggestions.at(index);

                        return existing.kind === next?.kind && existing.label === next.label && existing.detail === next.detail;
                    });

                return unchanged ? current : { active: 0, left, suggestions, top };
            });
        },
        [schema, textareaRef],
    );

    const close = (): void => {
        setState(null);
    };

    const move = (delta: number): void => {
        setState((current) => {
            if (current === null) {
                return current;
            }

            const count = current.suggestions.length;
            const active = (current.active + delta + count) % count;

            return { ...current, active };
        });
    };

    /**
     * Accept a suggestion by index, defaulting to the highlighted one.
     *
     * The index is a parameter because the mouse path cannot get there via
     * {@link move}: `move` schedules a state update, so a `commit()` called straight
     * after it still reads the pre-move `active` and inserts whatever was highlighted
     * rather than what was clicked.
     */
    const commitAt = (index?: number): boolean => {
        const textarea = textareaRef.current;

        if (state === null || textarea === null) {
            return false;
        }

        const chosen = state.suggestions[index ?? state.active];

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
    };

    const commit = (): boolean => commitAt();

    return { close, commit, commitAt, move, refresh, state };
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

/** Drop the popover just below the caret's line so it never covers the glyph being typed. */
const CARET_LINE_OFFSET = 20;

/**
 * The completion list floated over the editor at the caret. An ARIA `listbox`
 * whose options the textarea references via `aria-activedescendant`, so a screen
 * reader announces the highlighted candidate as the operator arrows through it.
 * Positioned absolutely at the caret's pixel offset (one line below it) so it
 * overlays the text instead of being pinned to the bottom of the editor pane.
 * Mouse hover/click mirror the keyboard path. Renders nothing when closed.
 */
const AutocompletePopover = ({ listboxId, onPick, state }: AutocompletePopoverProps): null | ReactElement => {
    const t = useT();
    const style = state === null ? undefined : { left: state.left, top: state.top + CARET_LINE_OFFSET };

    if (state === null) {
        return null;
    }

    return (
        <ul
            className="absolute z-30 max-h-56 w-72 overflow-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
            data-testid="sql-autocomplete"
            id={listboxId}
            role="listbox"
            style={style}
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
                    onMouseDown={(event) => {
                        // Pick on mousedown (before the textarea blurs) so the click lands.
                        event.preventDefault();
                        onPick(index);
                    }}
                    role="option"
                >
                    <span className="truncate font-mono">{suggestion.label}</span>
                    {suggestion.detail !== undefined && <span className="ms-auto truncate text-xs text-muted-foreground">{suggestion.detail}</span>}
                    <span className="shrink-0 font-mono text-[10px] tracking-wide text-muted-foreground/70 uppercase">{t(KIND_LABEL[suggestion.kind])}</span>
                </li>
            ))}
        </ul>
    );
};

export { AutocompletePopover, useSqlAutocomplete };
export type { SqlAutocomplete };
