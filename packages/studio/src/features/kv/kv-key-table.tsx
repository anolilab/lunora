import type { KvKeyEntry } from "@lunora/client";
import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import type { MouseEvent, ReactElement } from "react";
import { useRef } from "react";

import { Checkbox } from "../../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import flooredRectObserver from "../../lib/virtual-rect";
import { formatExpiration } from "./kv-fields";

/**
 * Height of one key row. Every data row is pinned to this height (a 16px
 * checkbox plus cell padding renders within it), so the virtualizer's offsets
 * match what is on screen and rows never need measuring.
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

const isDocumentScroll = (instance: Virtualizer<Element, Element>): boolean => instance.scrollElement === document.scrollingElement;

/**
 * Offset observer for a list that scrolls with the document. The element
 * observer would listen on `<html>`, which never receives viewport scroll
 * events, so the window is the scroll target and the list's offset is how far
 * its body has scrolled above the window top.
 */
const observeDocumentOffset = (
    instance: Virtualizer<Element, Element>,
    callback: (offset: number, isScrolling: boolean) => void,
    bodyOf: () => HTMLElement | null,
): (() => void) | undefined => {
    const win = instance.targetWindow;

    if (!win) {
        return undefined;
    }

    const report = (isScrolling: boolean): void => {
        callback(Math.max(0, -(bodyOf()?.getBoundingClientRect().top ?? 0)), isScrolling);
    };
    const onScroll = (): void => {
        report(true);
    };
    const onScrollEnd = (): void => {
        report(false);
    };

    report(false);
    win.addEventListener("scroll", onScroll, { passive: true });
    win.addEventListener("scrollend", onScrollEnd);

    return () => {
        win.removeEventListener("scroll", onScroll);
        win.removeEventListener("scrollend", onScrollEnd);
    };
};

/** Rect for a document-scrolling list: the window viewport, not `<html>`, which spans the whole page. */
const observeDocumentRect = (instance: Virtualizer<Element, Element>, callback: (rect: Rect) => void): (() => void) | undefined => {
    const win = instance.targetWindow;

    if (!win) {
        return undefined;
    }

    const handler = (): void => {
        callback({ height: win.innerHeight, width: win.innerWidth });
    };

    handler();
    win.addEventListener("resize", handler);

    return () => {
        win.removeEventListener("resize", handler);
    };
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
        // grows or shrinks is not re-read until the next scroll.
        observeElementOffset: (instance, callback) =>
            isDocumentScroll(instance)
                ? observeDocumentOffset(instance, callback, () => bodyRef.current)
                : observeElementOffset(instance, (_offset, isScrolling) => {
                      const scroller = instance.scrollElement;
                      const body = bodyRef.current;

                      callback(scroller && body ? Math.max(0, scroller.getBoundingClientRect().top - body.getBoundingClientRect().top) : 0, isScrolling);
                  }),
        observeElementRect: (instance, callback) =>
            isDocumentScroll(instance) ? observeDocumentRect(instance, callback) : flooredRectObserver(instance, callback, FALLBACK_VIEWPORT),
        overscan: 12,
    });
    const virtualRows = virtualizer.getVirtualItems();
    // Sized from every loaded key, not the mounted window, so scrolling never widens the table.
    let longestKey = 0;

    for (const entry of keys) {
        longestKey = Math.max(longestKey, entry.name.length);
    }
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
                            style={{ height: ROW_HEIGHT }}
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
                            <TableCell className="font-mono text-xs" style={{ width: `${String(longestKey)}ch` }}>
                                {entry.name}
                            </TableCell>
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
