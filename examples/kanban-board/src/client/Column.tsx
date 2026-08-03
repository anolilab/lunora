import type { CSSProperties, DragEvent, ReactElement } from "react";
import { useState } from "react";

import type { Status, Task } from "./types.js";

const LABELS: Record<Status, string> = {
    archived: "Archived",
    done: "Done",
    "in-progress": "In Progress",
    todo: "To Do",
};

/**
 * Which slot the pointer is hovering, from the midpoints of the cards already
 * rendered in this column. Native HTML5 drag events only tell us *where* the
 * pointer is, so the insertion index is ours to work out — and it is the only
 * thing the `move` mutation needs, because the order key itself is resolved
 * server-side.
 */
const dropIndexAt = (list: HTMLElement, clientY: number): number => {
    const cards = [...list.querySelectorAll<HTMLElement>("[data-card]")];
    const index = cards.findIndex((card) => {
        const box = card.getBoundingClientRect();

        return clientY < box.top + box.height / 2;
    });

    return index === -1 ? cards.length : index;
};

interface ColumnProperties {
    /** Feeds the CSS entrance stagger, so columns arrive left to right. */
    columnIndex: number;
    /** `false` while a search filters the column, when a drop index would not map to the real order. */
    draggable: boolean;
    onCreate: (status: Status, title: string) => void;
    onDelete: (task: Task) => void;
    onDrop: (status: Status, index: number) => void;
    onRename: (task: Task, title: string) => void;
    onDragStart: (task: Task) => void;
    status: Status;
    tasks: Task[];
}

export const Column = ({ columnIndex, draggable, onCreate, onDelete, onDragStart, onDrop, onRename, status, tasks }: ColumnProperties): ReactElement => {
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [composing, setComposing] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);

    const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
        if (!draggable) {
            return;
        }

        event.preventDefault();
        setDropIndex(dropIndexAt(event.currentTarget, event.clientY));
    };

    const onDropCard = (event: DragEvent<HTMLDivElement>): void => {
        if (!draggable) {
            return;
        }

        event.preventDefault();
        onDrop(status, dropIndexAt(event.currentTarget, event.clientY));
        setDropIndex(null);
    };

    return (
        <section className="column" style={{ "--col": columnIndex } as CSSProperties} aria-label={LABELS[status]}>
            <header className="column-header">
                <h2>{LABELS[status]}</h2>
                <span className="count">{tasks.length}</span>
            </header>

            <div className="column-body" onDragLeave={() => setDropIndex(null)} onDragOver={onDragOver} onDrop={onDropCard}>
                {tasks.map((task, index) => (
                    <div key={task._id} style={{ "--i": index } as CSSProperties}>
                        {dropIndex === index && <div className="drop-indicator" />}
                        <article
                            className="card"
                            data-card=""
                            draggable={draggable}
                            onDragEnd={() => setDropIndex(null)}
                            onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                onDragStart(task);
                            }}
                        >
                            {editing === task._id ? (
                                <input
                                    autoFocus
                                    aria-label="Card title"
                                    className="card-input"
                                    defaultValue={task.title}
                                    onBlur={(event) => {
                                        const next = event.target.value.trim();

                                        if (next && next !== task.title) {
                                            onRename(task, next);
                                        }

                                        setEditing(null);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.currentTarget.blur();
                                        }

                                        if (event.key === "Escape") {
                                            setEditing(null);
                                        }
                                    }}
                                />
                            ) : (
                                <>
                                    <button className="card-title" onClick={() => setEditing(task._id)} type="button">
                                        {task.title}
                                    </button>
                                    <button aria-label={`Delete ${task.title}`} className="card-delete" onClick={() => onDelete(task)} type="button">
                                        ×
                                    </button>
                                </>
                            )}
                        </article>
                    </div>
                ))}

                {dropIndex === tasks.length && <div className="drop-indicator" />}
            </div>

            {composing ? (
                <input
                    autoFocus
                    aria-label={`New card in ${LABELS[status]}`}
                    className="card-input"
                    onBlur={() => setComposing(false)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            setComposing(false);
                        }

                        if (event.key !== "Enter") {
                            return;
                        }

                        const title = event.currentTarget.value.trim();

                        if (title) {
                            onCreate(status, title);
                            event.currentTarget.value = "";
                        }
                    }}
                    placeholder="Card title, then Enter"
                />
            ) : (
                <button className="add-card" onClick={() => setComposing(true)} type="button">
                    + Add a card
                </button>
            )}
        </section>
    );
};
