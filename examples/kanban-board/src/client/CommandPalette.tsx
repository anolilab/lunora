import type { ReactElement } from "react";
import { useState } from "react";

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

/** ⌘K palette. Rendered only while open, so it needs no `isOpen` branch of its own. */
export const CommandPalette = ({ commands, onClose }: CommandPaletteProperties): ReactElement => {
    const [filter, setFilter] = useState("");
    const matches = commands.filter((command) => command.title.toLowerCase().includes(filter.toLowerCase()));

    return (
        <div className="palette-backdrop" onClick={onClose} role="presentation">
            <div className="palette" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Command palette" aria-modal="true">
                <input
                    autoFocus
                    aria-label="Filter commands"
                    className="palette-input"
                    onChange={(event) => setFilter(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            onClose();
                        }

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
            </div>
        </div>
    );
};
