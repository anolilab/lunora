import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

export interface Command {
    id: string;
    run: () => void;
    shortcut: string;
    title: string;
}

interface CommandPaletteProperties {
    commands: Command[];
    onClose: () => void;
}

/**
 * ⌘K palette. Rendered only while open, so it needs no `isOpen` branch of its own.
 *
 * A native `<dialog>` opened with `showModal()`, not a hand-rolled backdrop: the
 * platform gives focus trapping, inertness of the page behind it, Escape-to-close
 * and the `::backdrop` for free — all of which a `div` has to reimplement, and
 * usually reimplements incompletely.
 */
export const CommandPalette = ({ commands, onClose }: CommandPaletteProperties): ReactElement => {
    const [filter, setFilter] = useState("");
    const dialogRef = useRef<HTMLDialogElement>(null);
    const matches = commands.filter((command) => command.title.toLowerCase().includes(filter.toLowerCase()));

    useEffect(() => {
        // `showModal()` is what makes it modal; rendering the element alone does not.
        dialogRef.current?.showModal();
    }, []);

    return (
        <dialog ref={dialogRef} aria-label="Command palette" className="palette" onCancel={onClose} onClose={onClose}>
            <input
                autoFocus
                aria-label="Filter commands"
                className="palette-input"
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                    // Escape is handled by the dialog's own `cancel` event.
                    if (event.key === "Enter") {
                        matches[0]?.run();
                    }
                }}
                placeholder="Type a command…"
                value={filter}
            />

            <ul className="palette-list">
                {matches.map((command) => (
                    <li key={command.id}>
                        <button className="palette-item" onClick={command.run} type="button">
                            <span>{command.title}</span>
                            <kbd>{command.shortcut}</kbd>
                        </button>
                    </li>
                ))}
            </ul>
        </dialog>
    );
};
