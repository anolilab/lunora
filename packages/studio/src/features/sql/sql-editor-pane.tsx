import type { CSSProperties, ReactElement, RefObject } from "react";

import { useT } from "../../i18n/i18n-context";
import { EDITOR_TEXT_CLASS } from "./editor-spans";
import type { SqlAssistant } from "./hooks/use-sql-assistant";
import { SqlAssistantBar } from "./sql-assistant-bar";
import type { SqlAutocomplete } from "./sql-autocomplete-ui";
import { AutocompletePopover } from "./sql-autocomplete-ui";
import type { SqlDiagnostic } from "./sql-diagnostics";
import { DiagnosticsOverlay, DiagnosticsRow } from "./sql-diagnostics-ui";

/** Line-number gutter sizing, aligned to the editor textarea's padding + line height. */
const GUTTER_STYLE: CSSProperties = { minWidth: "2.75rem", paddingInline: "0.5rem" };

/**
 * The line-numbered editor pane: the assistant bar, the gutter, the textarea with
 * its diagnostics overlay and completion popover, and the problems row.
 *
 * All of its state lives in the panel — this is the markup plus the three refs the
 * scroll-sync and caret math need. The handlers arrive as one object because the
 * pane only forwards them to the textarea and reads none of them; the refs do NOT,
 * for the reason noted on the props below.
 */
const SqlEditorPane = ({
    assistant,
    autocomplete,
    diagnostics,
    draft,
    failed,
    handlers,
    editorRef,
    gutterRef,
    listboxId,
    onGenerated,
    onPickSuggestion,
    onRevealDiagnostic,
    overlayRef,
}: {
    readonly assistant: SqlAssistant;
    /** The completion popover's state, or `null` when closed. */
    readonly autocomplete: SqlAutocomplete["state"];
    readonly diagnostics: ReadonlyArray<SqlDiagnostic>;

    readonly draft: string;

    /**
     * The three scroll-synced nodes. Separate props, not one object: the React Compiler
     * bails out of the whole component when a ref reaches the JSX through a member access.
     */
    readonly editorRef: RefObject<HTMLTextAreaElement | null>;
    /** The active tab's last failed statement, which arms the assistant's "Fix this". */
    readonly failed?: { error: string; sql: string };
    readonly gutterRef: RefObject<HTMLDivElement | null>;
    /** The textarea's event wiring — caret tracking, completion keys, and scroll sync. */
    readonly handlers: {
        onBlur: () => void;
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
        onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
        onScroll: (event: React.UIEvent<HTMLTextAreaElement>) => void;
        onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
    };
    readonly listboxId: string;
    readonly onGenerated: (sql: string) => void;
    readonly onPickSuggestion: (index: number) => void;
    readonly onRevealDiagnostic: (diagnostic: SqlDiagnostic) => void;
    readonly overlayRef: RefObject<HTMLDivElement | null>;
}): ReactElement => {
    const t = useT();
    const lineCount = draft.split("\n").length;

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SqlAssistantBar assistant={assistant} failed={failed} onGenerated={onGenerated} />
            <div className="flex min-h-0 min-w-0 flex-1">
                <div
                    aria-hidden="true"
                    className="shrink-0 select-none overflow-hidden border-e border-border bg-muted/30 py-3 text-end font-mono text-xs leading-5 text-muted-foreground/60"
                    ref={gutterRef}
                    style={GUTTER_STYLE}
                >
                    {Array.from({ length: lineCount }, (_, index) => (
                        <div key={index}>{index + 1}</div>
                    ))}
                </div>
                {/* The background lives on the wrapper, not the textarea: the
                    overlay sits behind the (transparent) textarea, so an opaque
                    textarea would hide every squiggle. */}
                <div className="relative min-w-0 flex-1 bg-background">
                    <DiagnosticsOverlay diagnostics={diagnostics} draft={draft} scrollRef={overlayRef} />
                    <textarea
                        aria-activedescendant={autocomplete === null ? undefined : `${listboxId}-opt-${autocomplete.active.toString()}`}
                        aria-autocomplete="list"
                        aria-controls={autocomplete === null ? undefined : listboxId}
                        aria-expanded={autocomplete !== null}
                        aria-label={t("SQL query")}
                        className={`relative size-full resize-none bg-transparent outline-none ${EDITOR_TEXT_CLASS}`}
                        data-testid="sql-input"
                        onBlur={handlers.onBlur}
                        onChange={handlers.onChange}
                        onKeyDown={handlers.onKeyDown}
                        onScroll={handlers.onScroll}
                        onSelect={handlers.onSelect}
                        placeholder="SELECT * FROM …"
                        ref={editorRef}
                        role="combobox"
                        spellCheck={false}
                        value={draft}
                    />
                    <AutocompletePopover listboxId={listboxId} onPick={onPickSuggestion} state={autocomplete} />
                </div>
            </div>
            <DiagnosticsRow diagnostics={diagnostics} onSelect={onRevealDiagnostic} />
        </div>
    );
};

export { SqlEditorPane };
