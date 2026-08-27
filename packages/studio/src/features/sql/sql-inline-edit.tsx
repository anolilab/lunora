import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { Input } from "../../components/ui/input";
import type { AssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { cn } from "../../lib/utils";
import assistantReasonMessage from "./assistant-reason";
import { EDITOR_TEXT_CLASS } from "./editor-spans";
import type { DiffLine } from "./line-diff";
import { lineDiff } from "./line-diff";

/** Per-kind row styling and the gutter marker. Colour is never the only signal — see the a11y note on the diff. */
const ROW_CLASS: Readonly<Record<DiffLine["kind"], string>> = {
    added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    context: "text-muted-foreground",
    removed: "bg-destructive/10 text-destructive",
};

const ROW_MARKER: Readonly<Record<DiffLine["kind"], string>> = { added: "+", context: " ", removed: "-" };

/**
 * The proposed rewrite, as a unified line diff.
 *
 * A `<ul>` rather than a pair of panes: the editor is a plain textarea with no
 * diff view to borrow, and a side-by-side needs width the console does not have
 * above a full-height editor. Unified also survives a screen reader, which
 * side-by-side does not.
 *
 * **Colour is not the only signal.** Each row carries the conventional `+`/`-`
 * marker for sighted readers and a visually-hidden word for assistive ones, so
 * the diff reads correctly in a high-contrast theme and out loud.
 */
const DiffView = ({ lines }: { readonly lines: ReadonlyArray<DiffLine> }): ReactElement => {
    const t = useT();

    return (
        <ul
            aria-label={t("Proposed edit")}
            className={cn("max-h-48 overflow-auto rounded-md border border-border bg-background", EDITOR_TEXT_CLASS)}
            data-testid="sql-inline-diff"
        >
            {lines.map((line, index) => (
                <li className={cn("flex gap-2", ROW_CLASS[line.kind])} data-kind={line.kind} key={`${index.toString()}-${line.text}`}>
                    <span aria-hidden="true" className="shrink-0 select-none opacity-60">
                        {ROW_MARKER[line.kind]}
                    </span>
                    {line.kind !== "context" && <span className="sr-only">{line.kind === "added" ? t("Added") : t("Removed")}</span>}
                    <span className="min-w-0">{line.text === "" ? " " : line.text}</span>
                </li>
            ))}
        </ul>
    );
};

const ACTION_CLASS = "rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent";

/**
 * Inline "edit this SQL with AI": an instruction box over the operator's own
 * statement, answered with a diff they accept or reject.
 *
 * Armed by ⌘/Ctrl+I in the editor and rendered directly above it, in the same
 * band as the prompt bar — the two are the same affordance seen from different
 * ends (write me one / change this one), so they read as one strip rather than
 * two competing AI surfaces.
 *
 * **The draft is not touched until Accept.** Reject and Escape therefore restore
 * exactly what was there by construction, rather than by remembering to put it
 * back — the failure mode of a preview that edits first and undoes later is that
 * one path forgets, and the operator loses work they never agreed to change.
 *
 * The rewrite goes through the SAME `aiGenerateSql` op and so the same read-only
 * gate as the prompt bar's draft, and lands in the editor UNRUN. Renders nothing
 * when the deployment cannot run the assistant.
 */
const SqlInlineEdit = ({
    onAccept,
    onCancel,
    rpc,
    source,
    whole,
}: {
    /** Take the proposal into the editor, replacing what was rewritten. */
    readonly onAccept: (sql: string) => void;
    /** Dismiss without touching the draft. */
    readonly onCancel: () => void;
    readonly rpc: AssistantRpc;
    /** The statement being rewritten — the operator's selection, or the whole draft. */
    readonly source: string;
    /** True when the target is the whole draft rather than a selection, which the badge names. */
    readonly whole: boolean;
}): ReactElement | null => {
    const t = useT();

    const inputRef = useRef<HTMLInputElement | null>(null);
    const acceptRef = useRef<HTMLButtonElement | null>(null);
    const [instruction, setInstruction] = useState("");
    const [proposal, setProposal] = useState<null | string>(null);

    /*
     * Keep focus inside the panel across its two states.
     *
     * Landing on Accept when the proposal arrives matters: the control that was
     * focused (the instruction box) is unmounted at that moment, and focus would
     * otherwise fall to `<body>` — leaving a keyboard operator with a decision on
     * screen and no way to reach it but Tab-from-the-top.
     */
    useEffect(() => {
        if (proposal === null) {
            inputRef.current?.focus();
        } else {
            acceptRef.current?.focus();
        }
    }, [proposal]);

    if (rpc.unavailable) {
        return null;
    }

    const pending = rpc.pending("sql");
    const reason = rpc.reason("sql");

    const submit = (): void => {
        const text = instruction.trim();

        if (text === "" || source.trim() === "") {
            return;
        }

        const ask = async (): Promise<void> => {
            const sql = await rpc.rewrite(text, source);

            if (sql !== undefined) {
                setProposal(sql);
            }
        };

        fireAndForget(ask());
    };

    // Escape backs out from wherever focus is — the instruction box or either
    // decision button. On the buttons it is the keyboard twin of Reject.
    const onEscape = (event: React.KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
        }
    };

    return (
        <div className="flex flex-col gap-1 border-b border-border bg-muted/20 px-3 py-2" data-testid="sql-inline-edit">
            <div className="flex items-center gap-2">
                <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] uppercase text-muted-foreground" data-testid="sql-inline-edit-scope">
                    {whole ? t("Whole query") : t("Selection")}
                </span>
                {proposal === null ? (
                    <>
                        <Input
                            aria-label={t("Tell the model what to change")}
                            className="h-7 flex-1 text-xs"
                            data-testid="sql-inline-edit-prompt"
                            disabled={pending}
                            onChange={(event) => {
                                setInstruction(event.target.value);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    submit();

                                    return;
                                }

                                onEscape(event);
                            }}
                            placeholder={t("Tell the model what to change")}
                            ref={inputRef}
                            value={instruction}
                        />
                        <button
                            className={cn(ACTION_CLASS, pending && "opacity-60")}
                            data-testid="sql-inline-edit-submit"
                            disabled={pending || instruction.trim() === ""}
                            onClick={submit}
                            onKeyDown={onEscape}
                            type="button"
                        >
                            {pending ? t("Thinking…") : t("Rewrite")}
                        </button>
                        <button className={ACTION_CLASS} data-testid="sql-inline-edit-cancel" onClick={onCancel} onKeyDown={onEscape} type="button">
                            {t("Cancel")}
                        </button>
                    </>
                ) : (
                    <>
                        <span className="flex-1 text-xs text-muted-foreground">{t("Proposed edit")}</span>
                        <button
                            className={ACTION_CLASS}
                            data-testid="sql-inline-edit-accept"
                            onClick={() => {
                                onAccept(proposal);
                            }}
                            onKeyDown={onEscape}
                            ref={acceptRef}
                            type="button"
                        >
                            {t("Accept")}
                        </button>
                        {/* Reject returns to the instruction box rather than closing:
                            a rewrite that missed is usually one word away, and
                            re-arming the chord to retype the whole request is a tax
                            on the case that needs the affordance most. */}
                        <button
                            className={ACTION_CLASS}
                            data-testid="sql-inline-edit-reject"
                            onClick={() => {
                                setProposal(null);
                            }}
                            onKeyDown={onEscape}
                            type="button"
                        >
                            {t("Reject")}
                        </button>
                    </>
                )}
            </div>
            {proposal !== null && <DiffView lines={lineDiff(source, proposal)} />}
            {reason !== undefined && (
                <p className="text-[11px] text-muted-foreground" data-testid="sql-inline-edit-reason" role="status">
                    {assistantReasonMessage(reason, t)}
                </p>
            )}
        </div>
    );
};

export default SqlInlineEdit;
