import { Dialog } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n/i18n-context";
import { fireAndForget } from "../lib/internal";
import { cn } from "../lib/utils";

/** A navigable destination shown in the palette. */
interface CommandItem {
    /** Localised domain label, shown as a muted suffix to disambiguate. */
    readonly group: string;
    /** Localised sub-page label, the primary search target. */
    readonly label: string;
    /** Router path to navigate to on select (e.g. `/logs`). */
    readonly to: string;
}

interface CommandPaletteProps {
    /** Every navigable destination, in rail order. */
    readonly items: ReadonlyArray<CommandItem>;
}

/**
 * The DOM event the top-bar Search button dispatches to open the palette. The
 * button lives in the app header — above the studio's router — so it can't share
 * React state with this component; a window event bridges the two without
 * threading a callback across the `RouterProvider` boundary.
 */
const OPEN_EVENT = "lunora:command-palette";

/** Open the command palette from anywhere (e.g. the top-bar Search button). */
const openCommandPalette = (): void => {
    if ("window" in globalThis) {
        globalThis.dispatchEvent(new Event(OPEN_EVENT));
    }
};

interface CommandRowProps {
    /** Whether this row is the keyboard-active selection. */
    readonly active: boolean;
    /** Position in the filtered list, so hover can sync the active index. */
    readonly index: number;
    readonly item: CommandItem;
    readonly onActivate: (index: number) => void;
    readonly onSelect: (item: CommandItem) => void;
}

/**
 * One palette row. Extracted so its click/hover handlers bind through stable
 * `useCallback`s (closing over the row's item + index) rather than minting fresh
 * inline closures per render — the list re-renders on every keystroke.
 */
const CommandRow = ({ active, index, item, onActivate, onSelect }: CommandRowProps): ReactElement => {
    const onClick = (): void => {
        onSelect(item);
    };

    const onMouseEnter = (): void => {
        onActivate(index);
    };

    return (
        <li>
            <button
                className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-start text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                    active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
                onClick={onClick}
                onMouseEnter={onMouseEnter}
                type="button"
            >
                <span>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.group}</span>
            </button>
        </li>
    );
};

/**
 * Command palette (⌘K / Ctrl-K) — Supabase-style global search. Rendered inside
 * the studio shell so its selection can drive the router's `useNavigate`. Opens
 * on the keyboard shortcut or the {@link OPEN_EVENT} the top-bar Search button
 * dispatches, filters the navigable destinations by a case-insensitive substring
 * over their label and domain, and navigates to the chosen one. Built on the
 * studio's Base UI dialog primitive — no `cmdk`/extra dependency — with a small
 * arrow-key + Enter affordance over the filtered list.
 */
/** Items whose label or group contains `query` (case-insensitive); every item when the query is blank. */
const matchingItems = (items: ReadonlyArray<CommandItem>, query: string): ReadonlyArray<CommandItem> => {
    const needle = query.trim().toLowerCase();

    if (needle === "") {
        return items;
    }

    return items.filter((item) => item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle));
};

const CommandPalette = ({ items }: CommandPaletteProps): ReactElement => {
    const t = useT();
    const navigate = useNavigate();

    const [open, setOpen] = useState<boolean>(false);
    const [query, setQuery] = useState<string>("");
    const [activeIndex, setActiveIndex] = useState<number>(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Open on ⌘K / Ctrl-K and on the top-bar button's window event.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setOpen(true);
            }
        };

        const onOpen = (): void => {
            setOpen(true);
        };

        globalThis.addEventListener("keydown", onKeyDown);
        globalThis.addEventListener(OPEN_EVENT, onOpen);

        return (): void => {
            globalThis.removeEventListener("keydown", onKeyDown);
            globalThis.removeEventListener(OPEN_EVENT, onOpen);
        };
    }, []);

    const filtered = matchingItems(items, query);

    // Reset state each time the palette opens so it never reopens mid-filter.
    const onOpenChange = (next: boolean): void => {
        setOpen(next);

        if (!next) {
            setQuery("");
            setActiveIndex(0);
        }
    };

    const select = (item: CommandItem): void => {
        onOpenChange(false);
        fireAndForget(navigate({ to: item.to }));
    };

    const onInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setQuery(event.target.value);
        setActiveIndex(0);
    };

    const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        switch (event.key) {
            case "ArrowDown": {
                event.preventDefault();
                setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));

                break;
            }
            case "ArrowUp": {
                event.preventDefault();
                setActiveIndex((index) => (filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length));

                break;
            }
            case "Enter": {
                event.preventDefault();
                const item = filtered[activeIndex];

                if (item !== undefined) {
                    select(item);
                }

                break;
            }
            default: {
                break;
            }
        }
    };

    return (
        <Dialog.Root onOpenChange={onOpenChange} open={open}>
            <Dialog.Portal>
                <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
                <Dialog.Popup
                    className="fixed start-1/2 top-24 z-50 w-[36rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
                    data-testid="dash-command-palette"
                    initialFocus={inputRef}
                >
                    <Dialog.Title className="sr-only">{t("Command palette")}</Dialog.Title>
                    <div className="flex items-center gap-2 border-b border-border px-3">
                        <svg
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            viewBox="0 0 24 24"
                        >
                            <circle cx="11" cy="11" r="7" />
                            <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                        </svg>
                        <input
                            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            data-testid="dash-command-input"
                            onChange={onInputChange}
                            onKeyDown={onInputKeyDown}
                            placeholder={t("Search…")}
                            ref={inputRef}
                            type="text"
                            value={query}
                        />
                    </div>
                    <ul className="max-h-80 overflow-y-auto p-1.5" data-testid="dash-command-list">
                        {filtered.length === 0 ? (
                            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t("No results.")}</li>
                        ) : (
                            filtered.map((item, index) => (
                                <CommandRow
                                    active={index === activeIndex}
                                    index={index}
                                    item={item}
                                    key={item.to}
                                    onActivate={setActiveIndex}
                                    onSelect={select}
                                />
                            ))
                        )}
                    </ul>
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export { CommandPalette, openCommandPalette };
export type { CommandItem, CommandPaletteProps };
