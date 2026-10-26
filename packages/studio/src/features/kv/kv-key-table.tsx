import type { KvKeyEntry } from "@lunora/client";
import { observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import type { MouseEvent, ReactElement } from "react";
import { useRef } from "react";

import { Checkbox } from "../../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import flooredRectObserver from "../../lib/virtual-rect";
import { formatExpiration } from "./kv-fields";

/**
 * Height of one key row: a single-line, `whitespace-nowrap` cell around a
 * checkbox, so every row is the same height and rows are not measured. Spacers
 * use the same figure, so the layout stays self-consistent even if a theme
 * shifts the real height by a pixel; the overscan absorbs the difference.
 */
const ROW_HEIGHT = 33;

/** Viewport height (px) assumed when layout reports none (jsdom), so tests mount a bounded window. */
const FALLBACK_VIEWPORT = 600;

/**
 * The element the key list scrolls with: the nearest scrolling ancestor, which
 * in the studio shell is the panel's content area. Windowing against it (rather
 * than giving the table its own capped viewport) keeps the page exactly as it
 * was — the table still flows with the panel. The document is only the fallback
 * for an unstyled tree (jsdom), where the floored rect bounds the window.
 */
const scrollParentOf = (node: Element | null): Element | null => {
    for (let element = node?.parentElement ?? null; element !== null; element = element.parentElement) {
        const { overflowY } = getComputedStyle(element);

        if (overflowY === "auto" || overflowY === "scroll") {
            return element;
        }
    }

    return document.scrollingElement;
};

interface KvKeyTableProps {
    readonly allSelected: boolean;
    readonly bulkSelected: ReadonlySet<string>;
    readonly keys: ReadonlyArray<KvKeyEntry>;
    readonly onSelectKey: (event: MouseEvent<HTMLTableRowElement>) => void;
    readonly onToggleAll: (checked: boolean) => void;
    readonly onToggleBulk: (name: string) => void;
    readonly selectedKey: null | string;
}

/**
 * The namespace's key table, windowed: only the rows in (or near) the visible
 * part of the panel mount. "Load more" appends pages without bound, and the
 * table used to mount every key it had ever fetched — thousands of rows, each
 * with a Base UI checkbox, re-rendered on every keystroke and selection toggle.
 * Spacer rows above and below stand in for the rest, so this stays a real
 * `<table>` with the same columns, row markup and page layout as before.
 */
const KvKeyTable = ({ allSelected, bulkSelected, keys, onSelectKey, onToggleAll, onToggleBulk, selectedKey }: KvKeyTableProps): ReactElement => {
    const t = useT();
    const bodyRef = useRef<HTMLTableSectionElement>(null);

    // react-doctor-disable-next-line react-hooks-js/incompatible-library -- TanStack Virtual returns functions the compiler refuses to memoize; the alternative is not using the library
    const virtualizer = useVirtualizer({
        count: keys.length,
        estimateSize: () => ROW_HEIGHT,
        getItemKey: (index) => keys[index]?.name ?? index,
        getScrollElement: () => scrollParentOf(bodyRef.current),
        initialRect: { height: FALLBACK_VIEWPORT, width: 800 },
        // The list does not start at the top of the scroll area (the namespace
        // table and the filter bar sit above it), so the scroll offset the
        // virtualizer needs is how far the list's first row has scrolled past the
        // viewport top — read from layout on each scroll, so content above that
        // grows or shrinks never leaves the window misaligned.
        observeElementOffset: (instance, callback) =>
            observeElementOffset(instance, (_offset, isScrolling) => {
                const scroller = instance.scrollElement;
                const body = bodyRef.current;

                callback(scroller && body ? Math.max(0, scroller.getBoundingClientRect().top - body.getBoundingClientRect().top) : 0, isScrolling);
            }),
        observeElementRect: (instance, callback) => flooredRectObserver(instance, callback, FALLBACK_VIEWPORT),
        overscan: 12,
    });
    const virtualRows = virtualizer.getVirtualItems();
    const padTop = virtualRows[0]?.start ?? 0;
    const padBottom = virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0);

    return (
        <Table data-testid="kv-key-table">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-10">
                        <Checkbox aria-label={t("Select all")} checked={allSelected} data-testid="kv-select-all" onCheckedChange={onToggleAll} />
                    </TableHead>
                    <TableHead>{t("Key")}</TableHead>
                    <TableHead>{t("Expiration")}</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody ref={bodyRef}>
                {padTop > 0 && <tr aria-hidden="true" style={{ height: padTop }} />}
                {virtualRows.map((virtualRow) => {
                    const entry = keys[virtualRow.index];

                    return entry === undefined ? null : (
                        <TableRow
                            className={entry.name === selectedKey ? "border-l-2 border-l-royal-amethyst bg-muted/50" : "cursor-pointer"}
                            data-key={entry.name}
                            data-testid={`kv-key-row-${entry.name}`}
                            key={entry.name}
                            onClick={onSelectKey}
                        >
                            <TableCell
                                onClick={(event) => {
                                    event.stopPropagation();
                                }}
                            >
                                <Checkbox
                                    aria-label={t("Select {name}", { name: entry.name })}
                                    checked={bulkSelected.has(entry.name)}
                                    data-testid={`kv-select-${entry.name}`}
                                    onCheckedChange={() => {
                                        onToggleBulk(entry.name);
                                    }}
                                />
                            </TableCell>
                            <TableCell className="font-mono text-xs">{entry.name}</TableCell>
                            <TableCell className="tabular-nums text-xs">{formatExpiration(entry.expiration)}</TableCell>
                        </TableRow>
                    );
                })}
                {padBottom > 0 && <tr aria-hidden="true" style={{ height: padBottom }} />}
            </TableBody>
        </Table>
    );
};

export default KvKeyTable;
