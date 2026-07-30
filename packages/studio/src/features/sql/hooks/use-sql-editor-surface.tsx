import type { RefObject } from "react";
import { useEffect, useId, useRef } from "react";

import type { SqlSchema } from "../sql-autocomplete";
import type { SqlAutocomplete } from "../sql-autocomplete-ui";
import { useSqlAutocomplete } from "../sql-autocomplete-ui";
import type { SqlDiagnostic } from "../sql-diagnostics";
import { referencedTables } from "../sql-schema";

/** The textarea's event wiring — caret tracking, completion keys, and scroll sync. */
interface EditorHandlers {
    readonly onBlur: () => void;
    readonly onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    readonly onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    readonly onScroll: (event: React.UIEvent<HTMLTextAreaElement>) => void;
    readonly onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
}

/** Everything {@link useSqlEditorSurface} hands back — what the editor pane renders and wires. */
interface SqlEditorSurface {
    /** The completion popover's state, or `null` when closed. */
    readonly autocompleteState: SqlAutocomplete["state"];
    /** Dismiss the popover — also called when the panel switches tabs. */
    readonly closeAutocomplete: () => void;
    readonly handlers: EditorHandlers;
    /** The listbox id the textarea owns through `aria-controls`. */
    readonly listboxId: string;
    readonly onPickSuggestion: (index: number) => void;
    /** The gutter and overlay follow the textarea's scroll, so all three travel together. */
    readonly refs: {
        readonly editor: RefObject<HTMLTextAreaElement | null>;
        readonly gutter: RefObject<HTMLDivElement | null>;
        readonly overlay: RefObject<HTMLDivElement | null>;
    };
    /** Focus and select a diagnostic's span, so "unknown table `userz`" lands the caret on `userz`. */
    readonly revealDiagnostic: (diagnostic: SqlDiagnostic) => void;
}

/**
 * The editor textarea's interaction surface: schema-aware completion, caret
 * tracking, the keyboard map, gutter/overlay scroll sync, and diagnostic reveal.
 *
 * One hook because all of it is about the same DOM node, and all of it is about
 * where the caret is. It was seven handlers and an effect interleaved with the run
 * path in the panel, which is what made the panel hard to read — the editing
 * behaviour and the query lifecycle looked like one thing.
 */
const useSqlEditorSurface = ({
    onSubmit,
    probe,
    schema,
    setDraft,
}: {
    /** Run the query — Cmd/Ctrl-Enter in the editor. */
    readonly onSubmit: () => void;
    /** Pre-load a table's columns as soon as the draft names it. */
    readonly probe: (table: string) => void;
    readonly schema: SqlSchema;
    /** Write the draft (which also auto-saves the linked query). */
    readonly setDraft: (value: string) => void;
}): SqlEditorSurface => {
    const listboxId = useId();

    const gutterRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);

    const autocomplete = useSqlAutocomplete(schema, editorRef, setDraft);
    const {
        close: closeAutocomplete,
        commit: commitAutocomplete,
        move: moveAutocomplete,
        refresh: refreshAutocomplete,
        state: autocompleteState,
    } = autocomplete;

    // Pick the suggestion at `index` from the mouse path (mirror the keyboard commit).
    const onPickSuggestion = (index: number): void => {
        moveAutocomplete(index - (autocompleteState?.active ?? 0));
        commitAutocomplete();
    };

    // Re-derive completions once a probe resolves new columns: a `tbl.` qualifier
    // typed before its columns loaded would otherwise show an empty popover until
    // the next keystroke. Only re-runs while the editor is focused, against its
    // live caret, so it never pops a menu the operator didn't ask for.
    useEffect(() => {
        const node = editorRef.current;

        if (node !== null && node === document.activeElement) {
            refreshAutocomplete(node.value, node.selectionStart);
        }
    }, [refreshAutocomplete, schema]);
    // Edit the draft (auto-saving the linked query) and re-derive completions
    // from the new caret position, pre-probing any table the draft now names.
    const onDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        const { selectionStart, value } = event.target;

        setDraft(value);

        for (const table of referencedTables(value)) {
            probe(table);
        }

        refreshAutocomplete(value, selectionStart);
    };

    // Re-derive completions when the caret moves without an edit (arrow keys, click).
    const onEditorSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>): void => {
        const node = event.currentTarget;

        refreshAutocomplete(node.value, node.selectionStart);
    };

    const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        // Autocomplete navigation takes the keys while the popover is open.
        if (autocompleteState !== null) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveAutocomplete(1);

                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                moveAutocomplete(-1);

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                closeAutocomplete();

                return;
            }

            if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && commitAutocomplete()) {
                event.preventDefault();

                return;
            }
        }

        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
        }
    };

    const onEditorBlur = (): void => {
        // Defer so a mousedown-pick on a suggestion still resolves before close.
        requestAnimationFrame(() => {
            closeAutocomplete();
        });
    };

    // Keep the line-number gutter and the diagnostics overlay aligned with the
    // textarea's scroll. The overlay tracks both axes — a wide statement scrolls
    // horizontally, and a squiggle that doesn't follow is worse than none.
    const onEditorScroll = (event: React.UIEvent<HTMLTextAreaElement>): void => {
        const { scrollLeft, scrollTop } = event.currentTarget;

        if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = scrollTop;
        }

        if (overlayRef.current !== null) {
            overlayRef.current.scrollTop = scrollTop;
            overlayRef.current.scrollLeft = scrollLeft;
        }
    };

    // Reveal and select a diagnostic's span from the problems row, so a message
    // like "unknown table `userz`" lands the caret on `userz`.
    const revealDiagnostic = (diagnostic: SqlDiagnostic): void => {
        const node = editorRef.current;

        if (node === null || diagnostic.offset === undefined) {
            return;
        }

        node.focus();
        node.setSelectionRange(diagnostic.offset, diagnostic.offset + (diagnostic.length ?? 0));
    };
    return {
        autocompleteState,
        closeAutocomplete,
        handlers: {
            onBlur: onEditorBlur,
            onChange: onDraftChange,
            onKeyDown: onEditorKeyDown,
            onScroll: onEditorScroll,
            onSelect: onEditorSelect,
        },
        listboxId,
        onPickSuggestion,
        refs: { editor: editorRef, gutter: gutterRef, overlay: overlayRef },
        revealDiagnostic,
    };
};

export { useSqlEditorSurface };
export type { EditorHandlers, SqlEditorSurface };
