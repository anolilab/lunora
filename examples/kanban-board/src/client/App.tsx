import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Command } from "./CommandPalette.js";
import { CommandPalette } from "./CommandPalette.js";
import { Column } from "./Column.js";
import type { Status, Task } from "./types.js";
import { COLUMNS } from "./types.js";

/**
 * `list` returns rows in `(status, order)` order, so grouping preserves the
 * board's layout without a client-side sort — which is also what lets the
 * optimistic update below splice a card into place without minting an order key
 * of its own.
 */
const groupByStatus = (tasks: Task[]): Record<Status, Task[]> => {
    const grouped: Record<Status, Task[]> = { archived: [], done: [], "in-progress": [], todo: [] };

    for (const task of tasks) {
        grouped[task.status].push(task);
    }

    return grouped;
};

export const App = (): ReactElement => {
    const tasks = useQuery(api.tasks.list, {});

    const { mutate: create } = useMutation(api.tasks.create);
    const { mutate: rename } = useMutation(api.tasks.rename);

    /**
     * Optimistic drag: drop the card out of the list and splice it back in at
     * the position the pointer chose. The order *key* stays whatever the server
     * last said — it is recomputed inside the `move` mutation, and the delta
     * that comes back replaces this layer. Predicting the key here would mean
     * shipping the fractional-index algorithm to the browser for no gain.
     */
    const { mutate: move } = useMutation(api.tasks.move).withOptimisticUpdate((localStore, { id, index, status }) => {
        const current = localStore.getQuery(api.tasks.list, {});
        const card = current?.find((task) => task._id === id);

        if (!current || !card) {
            return;
        }

        const rest = current.filter((task) => task._id !== id);
        const slots = rest.flatMap((task, position) => (task.status === status ? [position] : []));
        const at = slots[index] ?? (slots.length > 0 ? (slots.at(-1) as number) + 1 : rest.length);

        localStore.setQuery(api.tasks.list, {}, rest.toSpliced(at, 0, { ...card, status }));
    });

    const { mutate: remove } = useMutation(api.tasks.remove).withOptimisticUpdate((localStore, { id }) => {
        const current = localStore.getQuery(api.tasks.list, {});

        if (current) {
            localStore.setQuery(
                api.tasks.list,
                {},
                current.filter((task) => task._id !== id),
            );
        }
    });

    const [search, setSearch] = useState("");
    const [dark, setDark] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const draggingRef = useRef<Task | null>(null);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!event.metaKey && !event.ctrlKey) {
                return;
            }

            if (event.key === "k") {
                event.preventDefault();
                setPaletteOpen(true);
            } else if (event.key === "f") {
                event.preventDefault();
                searchRef.current?.focus();
            } else if (event.key === "a") {
                event.preventDefault();
                setShowArchived((previous) => !previous);
            }
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => globalThis.removeEventListener("keydown", onKeyDown);
    }, []);

    const grouped = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const visible = needle ? (tasks ?? []).filter((task) => task.title.toLowerCase().includes(needle)) : (tasks ?? []);

        return groupByStatus(visible);
    }, [tasks, search]);

    const commands: Command[] = [
        {
            id: "search",
            run: () => {
                setPaletteOpen(false);
                searchRef.current?.focus();
            },
            shortcut: "⌘F",
            title: "Search cards",
        },
        {
            id: "archived",
            run: () => {
                setPaletteOpen(false);
                setShowArchived((previous) => !previous);
            },
            shortcut: "⌘A",
            title: showArchived ? "Hide archived column" : "Show archived column",
        },
        {
            id: "theme",
            run: () => {
                setPaletteOpen(false);
                setDark((previous) => !previous);
            },
            shortcut: "",
            title: dark ? "Switch to light mode" : "Switch to dark mode",
        },
    ];

    const visibleColumns = showArchived ? COLUMNS : COLUMNS.filter((column) => column !== "archived");

    // A drop index is an index into what the column renders. While a search is
    // filtering cards out, that is not the column's real order — so dragging is
    // switched off rather than allowed to drop cards in the wrong slot.
    const filtering = search.trim().length > 0;

    const onDrop = (status: Status, index: number): void => {
        const card = draggingRef.current;

        draggingRef.current = null;

        if (card && (card.status !== status || index !== grouped[status].indexOf(card))) {
            void move({ id: card._id, index, status });
        }
    };

    return (
        <div className={dark ? "app dark" : "app"}>
            <header className="app-header">
                <input
                    ref={searchRef}
                    aria-label="Search cards"
                    className="search"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search"
                    type="search"
                    value={search}
                />

                <div className="header-actions">
                    <button aria-label="Open command palette" onClick={() => setPaletteOpen(true)} title="⌘K" type="button">
                        ⌘K
                    </button>
                    <button aria-pressed={showArchived} onClick={() => setShowArchived((previous) => !previous)} title="⌘A" type="button">
                        Archived
                    </button>
                    <button aria-pressed={dark} onClick={() => setDark((previous) => !previous)} type="button">
                        {dark ? "Light" : "Dark"}
                    </button>
                </div>
            </header>

            {tasks === undefined ? (
                <p className="loading">Connecting…</p>
            ) : (
                <div className="columns">
                    {visibleColumns.map((status) => (
                        <Column
                            key={status}
                            draggable={!filtering}
                            onCreate={(column, title) => void create({ status: column, title })}
                            onDelete={(task) => void remove({ id: task._id })}
                            onDragStart={(task) => {
                                draggingRef.current = task;
                            }}
                            onDrop={onDrop}
                            onRename={(task, title) => void rename({ id: task._id, title })}
                            status={status}
                            tasks={grouped[status]}
                        />
                    ))}
                </div>
            )}

            {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
        </div>
    );
};
