import type { ReactElement } from "react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import type { ConsoleShown } from "../../components/operation-console-provider";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import { copyToClipboard } from "../../lib/internal";
import type { OperationEntry } from "../../lib/operation-log";
import { operationLog } from "../../lib/operation-log";
import { cn } from "../../lib/utils";

/** Strip the reserved admin prefix so rows read as `readTablePage`, not `__lunora_admin__:readTablePage`. */
const shortPath = (functionPath: string): string => functionPath.replace("__lunora_admin__:", "");

/** Subscribe a component to the session's operation tape. */
const useOperationLog = (): ReadonlyArray<OperationEntry> => useSyncExternalStore(operationLog.subscribe, operationLog.getSnapshot, operationLog.getSnapshot);

/** Badge variant per outcome. */
const statusVariant = (status: OperationEntry["status"]): "default" | "destructive" | "secondary" => {
    if (status === "error") {
        return "destructive";
    }

    return status === "pending" ? "secondary" : "default";
};

/** One row of the tape. */
const OperationRow = ({ entry, focused }: { readonly entry: OperationEntry; readonly focused: boolean }): ReactElement => {
    const t = useT();

    // Bring the entry an error surface pointed at into view, via a ref callback
    // rather than an effect: the callback re-attaches exactly when `focused`
    // flips (its identity is memoized on it), so the scroll fires when the row
    // mounts into an opening drawer AND when focus moves to another row — and
    // never on an unrelated re-render, which would fight the operator's own
    // scrolling.
    const scrollWhenFocused = useCallback(
        (node: HTMLLIElement | null): void => {
            if (node !== null && focused) {
                node.scrollIntoView({ block: "nearest" });
            }
        },
        [focused],
    );

    const copy = (): void => {
        copyToClipboard(`${entry.functionPath} ${entry.summary}${entry.shardKey === "" ? "" : ` (shard ${entry.shardKey})`}`);
    };

    return (
        <li
            className={cn("border-b border-border/60 last:border-b-0", focused && "bg-accent ring-1 ring-inset ring-primary/40")}
            data-testid="oc-row"
            ref={scrollWhenFocused}
        >
            <div className="flex items-start gap-2 px-3 py-1.5 text-xs">
                <Badge className="mt-px shrink-0" variant={statusVariant(entry.status)}>
                    {entry.status === "pending" ? "…" : entry.status}
                </Badge>
                <span className="shrink-0 font-mono text-[11px] text-foreground">{shortPath(entry.functionPath)}</span>
                {entry.kind === "subscription" && (
                    <Badge className="shrink-0" variant="outline">
                        {t("live")}
                    </Badge>
                )}
                {entry.summary !== "" && <span className="min-w-0 truncate text-muted-foreground">{entry.summary}</span>}
                <span className="ms-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                    {entry.shardKey !== "" && <span className="font-mono">{entry.shardKey}</span>}
                    {entry.resultCount !== undefined && <span>{t("{count} rows", { count: entry.resultCount })}</span>}
                    {entry.pushes !== undefined && entry.pushes > 0 && <span>{t("{count} pushes", { count: entry.pushes })}</span>}
                    {entry.durationMs !== undefined && <span>{entry.durationMs}ms</span>}
                    <button
                        aria-label={t("Copy")}
                        className="rounded px-1 outline-none hover:bg-accent focus-visible:bg-accent"
                        data-testid="oc-copy"
                        onClick={copy}
                        type="button"
                    >
                        ⧉
                    </button>
                </span>
            </div>
            {entry.error !== undefined && (
                <p className="px-3 pb-1.5 font-mono text-[11px] text-destructive" data-testid="oc-error">
                    {entry.error}
                </p>
            )}
        </li>
    );
};

/**
 * The operation console — a tape of what Studio itself just did.
 *
 * Complements, rather than replaces, the server-side audit panel: that one is
 * the SERVER's durable record of privileged writes, this one is the client's
 * view of every RPC this UI issued, in issue order, with timings and the
 * argument shapes (never the values — see `lib/operation-log.ts`).
 *
 * Rendered as a drawer rather than a nav page because it is a companion to
 * whatever page you are on, not a destination.
 */
export const OperationConsole = ({
    focusSeq,
    onClose,
    onShownChange,
    shown: shownFilter,
}: {
    /** Highlight and scroll to this tape entry, when the caller named one. */
    readonly focusSeq?: number;
    readonly onClose: () => void;
    readonly onShownChange: (shown: ConsoleShown) => void;

    /**
     * Which operations to list. A CONTROLLED prop, not local state seeded from
     * one: the drawer only remounts when it opens, so a seeded copy ignored
     * `openConsole({ errorsOnly: true })` on an already-open drawer.
     */
    readonly shown: ConsoleShown;
}): ReactElement => {
    const t = useT();

    const entries = useOperationLog();
    const [needle, setNeedle] = useState<string>("");

    const shown = useMemo(() => {
        const match = needle.trim().toLowerCase();

        // One predicate, not two chained filters — the tape can hold thousands of
        // entries and this re-runs on every keystroke.
        return entries
            .filter(
                (entry) =>
                    (shownFilter === "errors" ? entry.status === "error" : true) &&
                    (match === "" || `${entry.functionPath} ${entry.summary} ${entry.shardKey}`.toLowerCase().includes(match)),
            )
            .toReversed();
    }, [entries, needle, shownFilter]);

    const errorCount = entries.filter((entry) => entry.status === "error").length;

    return (
        <section aria-label={t("Operation console")} className="flex max-h-80 flex-col border-t border-border bg-card" data-testid="lunora-operation-console">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="text-xs font-medium">{t("Operation console")}</span>
                <Badge variant="secondary">{t("{count} calls", { count: entries.length })}</Badge>
                {errorCount > 0 && <Badge variant="destructive">{t("{count} failed", { count: errorCount })}</Badge>}
                <button
                    // A toggle, not a command: without `aria-pressed` a screen
                    // reader announces "Errors button" identically whether the
                    // list is filtered or not, and the tint is the only cue.
                    aria-pressed={shownFilter === "errors"}
                    className={cn("rounded px-2 py-0.5 text-xs outline-none hover:bg-accent focus-visible:bg-accent", shownFilter === "errors" && "bg-accent")}
                    data-testid="oc-filter-errors"
                    onClick={() => {
                        onShownChange(shownFilter === "errors" ? "all" : "errors");
                    }}
                    type="button"
                >
                    {t("Errors")}
                </button>
                <Input
                    aria-label={t("Filter")}
                    className="h-7 w-40 text-xs"
                    data-testid="oc-search"
                    onChange={(event) => {
                        setNeedle(event.target.value);
                    }}
                    placeholder={t("Filter")}
                    value={needle}
                />
                <button
                    className="ms-auto rounded px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                    data-testid="oc-clear"
                    onClick={() => {
                        operationLog.clear();
                    }}
                    type="button"
                >
                    {t("Clear")}
                </button>
                <button
                    aria-label={t("Hide")}
                    className="rounded px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                    data-testid="oc-close"
                    onClick={onClose}
                    type="button"
                >
                    ✕
                </button>
            </div>

            {shown.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground" data-testid="oc-empty">
                    {t("Every admin call this studio makes is recorded here.")}
                </p>
            ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="oc-rows">
                    {shown.map((entry) => (
                        <OperationRow entry={entry} focused={entry.seq === focusSeq} key={entry.seq} />
                    ))}
                </ul>
            )}
        </section>
    );
};
