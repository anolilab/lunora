import type { RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";

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

/**
 * The inline-rewrite chord: ⌘/Ctrl+I with nothing else held.
 *
 * Bound on the TEXTAREA rather than globally, so the only chords it can collide
 * with are this file's own map — the console's Ctrl+`, the palette's ⌘K and the
 * sidebar's ⌘B are global listeners on other keys. Shift is excluded because
 * ⌘⇧I is the browser's devtools.
 */
const isInlineEditChord = (event: React.KeyboardEvent): boolean =>
    (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i";

/**
 * The span the inline AI rewrite is targeting: the operator's selection, or the
 * whole draft when the caret was collapsed.
 *
 * Offsets rather than the text itself, because the panel must splice the
 * accepted rewrite back into the draft it came out of — and because holding the
 * text would be a second copy of the draft to keep in step.
 */
interface InlineEditTarget {
    readonly end: number;
    readonly start: number;
}

/** Everything {@link useSqlEditorSurface} hands back — what the editor pane renders and wires. */
interface SqlEditorSurface {
    /** The completion popover's state, or `null` when closed. */
    /** Splice an accepted AI rewrite over `inlineEdit`'s span and close the panel. */
    readonly acceptInlineEdit: (sql: string) => void;
    readonly autocompleteState: SqlAutocomplete["state"];
    /** Dismiss the popover — also called when the panel switches tabs. */
    readonly closeAutocomplete: () => void;
    /** Dismiss the inline rewrite panel, leaving the draft exactly as it was. */
    readonly closeInlineEdit: () => void;

    /**
     * The textarea, plus the gutter and overlay that follow its scroll. Flat, not
     * grouped: the React Compiler bails out of a component that reads a ref through a
     * member access, which costs the editor pane its automatic memoization.
     */
    readonly editorRef: RefObject<HTMLTextAreaElement | null>;
    readonly gutterRef: RefObject<HTMLDivElement | null>;
    readonly handlers: EditorHandlers;
    /** The span ⌘/Ctrl+I armed, or `null` when the rewrite panel is closed. */
    readonly inlineEdit: InlineEditTarget | null;
    /** The listbox id the textarea owns through `aria-controls`. */
    readonly listboxId: string;
    readonly onPickSuggestion: (index: number) => void;
    readonly overlayRef: RefObject<HTMLDivElement | null>;
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
    inlineEditEnabled,
    onSubmit,
    probe,
    schema,
    setDraft,
}: {
    /** Whether ⌘/Ctrl+I arms the AI rewrite — false when the deployment cannot run the assistant. */
    readonly inlineEditEnabled: boolean;
    /** Run the query — Cmd/Ctrl-Enter in the editor. */
    readonly onSubmit: () => void;
    /** Pre-load a table's columns as soon as the draft names it. */
    readonly probe: (table: string) => void;
    readonly schema: SqlSchema;
    /** Write the draft (which also auto-saves the linked query). */
    readonly setDraft: (value: string) => void;
}): SqlEditorSurface => {
    const listboxId = useId();

    const [inlineEdit, setInlineEdit] = useState<InlineEditTarget | null>(null);
    const gutterRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);

    const autocomplete = useSqlAutocomplete(schema, editorRef, setDraft);
    const {
        close: closeAutocomplete,
        commit: commitAutocomplete,
        commitAt: commitAutocompleteAt,
        move: moveAutocomplete,
        refresh: refreshAutocomplete,
        state: autocompleteState,
    } = autocomplete;

    // Pick the suggestion at `index` from the mouse path (mirror the keyboard commit).
    const onPickSuggestion = (index: number): void => {
        commitAutocompleteAt(index);
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
        // An armed rewrite holds OFFSETS into the draft it was armed over, so an
        // edit underneath it would have Accept splice the proposal across the
        // wrong characters. Dismissing is the honest answer: what the operator
        // asked to rewrite is not there any more.
        setInlineEdit(null);

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

    /**
     * Autocomplete navigation, which takes the keys while the popover is open.
     *
     * Answers whether it CONSUMED the key: Enter and Tab fall through to the
     * editor's own map when there is nothing to commit, so ⌘Enter still runs the
     * query with a popover on screen.
     */
    const onAutocompleteKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveAutocomplete(1);

            return true;
        }

        if (event.key === "ArrowUp") {
            event.preventDefault();
            moveAutocomplete(-1);

            return true;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            closeAutocomplete();

            return true;
        }

        if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && commitAutocomplete()) {
            event.preventDefault();

            return true;
        }

        return false;
    };

    const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (autocompleteState !== null && onAutocompleteKeyDown(event)) {
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();

            return;
        }

        // Arm the inline AI rewrite over the selection, or over the whole draft
        // when the caret is collapsed.
        if (inlineEditEnabled && isInlineEditChord(event)) {
            event.preventDefault();
            closeAutocomplete();

            const { selectionEnd, selectionStart, value } = event.currentTarget;

            setInlineEdit(selectionStart === selectionEnd ? { end: value.length, start: 0 } : { end: selectionEnd, start: selectionStart });
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

    const closeInlineEdit = (): void => {
        setInlineEdit(null);
        editorRef.current?.focus();
    };

    /*
     * Take the rewrite: splice it over the armed span and hand the editor back.
     *
     * Read off the live textarea rather than a captured draft so the splice uses
     * the same string the offsets were measured against. The selection is set in
     * the next frame because React re-writes a controlled textarea's `value` on
     * the render this `setDraft` triggers, which drops a selection set now — the
     * same deferral the blur handler above needs, for the same reason.
     */
    const acceptInlineEdit = (sql: string): void => {
        const node = editorRef.current;

        if (inlineEdit === null || node === null) {
            return;
        }

        const { end, start } = inlineEdit;

        setDraft(node.value.slice(0, start) + sql + node.value.slice(end));
        setInlineEdit(null);
        node.focus();
        requestAnimationFrame(() => {
            node.setSelectionRange(start, start + sql.length);
        });
    };

    return {
        acceptInlineEdit,
        autocompleteState,
        closeAutocomplete,
        closeInlineEdit,
        inlineEdit,
        handlers: {
            onBlur: onEditorBlur,
            onChange: onDraftChange,
            onKeyDown: onEditorKeyDown,
            onScroll: onEditorScroll,
            onSelect: onEditorSelect,
        },
        listboxId,
        onPickSuggestion,
        editorRef,
        gutterRef,
        overlayRef,
        revealDiagnostic,
    };
};

export { useSqlEditorSurface };
export type { EditorHandlers, InlineEditTarget, SqlEditorSurface };
