import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import type { PaletteCommand } from "./use-command-palette";

/**
 * ⌘K command palette (GAPS.md ring 3). Zero-dependency: substring matching
 * over injected commands (tab navigation + actions), arrow/enter keyboard
 * flow, Escape to dismiss. The dialog's state lives in an inner component
 * that mounts fresh on every open — no reset effects needed.
 */

interface CommandPaletteProps {
    commands: PaletteCommand[];
    onClose: () => void;
    open: boolean;
}

const PaletteDialog = ({ commands, onClose }: Omit<CommandPaletteProps, "open">): ReactElement => {
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);

    const matches = useMemo(() => {
        const needle = query.trim().toLowerCase();

        return needle === "" ? commands : commands.filter((command) => `${command.group} ${command.label}`.toLowerCase().includes(needle));
    }, [commands, query]);

    // Derived clamp instead of a reset effect: a shrinking match list can
    // never leave the cursor out of range.
    const cursor = Math.min(selected, Math.max(0, matches.length - 1));

    const run = (command: PaletteCommand | undefined): void => {
        if (command) {
            onClose();
            command.run();
        }
    };

    return (
        <div
            className="palette-overlay"
            onClick={onClose}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    onClose();
                }
            }}
            role="presentation"
        >
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- the click handler only stops overlay-close propagation; keyboard flow lives on the input */}
            <div
                aria-label="Command palette"
                aria-modal="true"
                className="palette"
                onClick={(event) => {
                    event.stopPropagation();
                }}
                role="dialog"
            >
                <input
                    aria-label="Search commands"
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- a command palette exists to receive keyboard input the instant it opens
                    autoFocus
                    className="palette-input"
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setSelected(0);
                    }}
                    onKeyDown={(event) => {
                        switch (event.key) {
                            case "ArrowDown": {
                                event.preventDefault();
                                setSelected(Math.min(cursor + 1, matches.length - 1));
                                break;
                            }
                            case "ArrowUp": {
                                event.preventDefault();
                                setSelected(Math.max(cursor - 1, 0));
                                break;
                            }
                            case "Enter": {
                                event.preventDefault();
                                run(matches[cursor]);
                                break;
                            }
                            default: {
                                break;
                            }
                        }
                    }}
                    placeholder="Jump to a tab or run an action…"
                    value={query}
                />
                <ul className="palette-list">
                    {matches.length === 0 ? <li className="palette-empty muted">Nothing matches.</li> : null}
                    {matches.map((command, index) => (
                        <li key={command.id}>
                            <button
                                className={index === cursor ? "palette-item selected" : "palette-item"}
                                onClick={() => {
                                    run(command);
                                }}
                                onMouseEnter={() => {
                                    setSelected(index);
                                }}
                                type="button"
                            >
                                <span className="muted">{command.group}</span>
                                <span>{command.label}</span>
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="palette-hint muted">↑↓ navigate · ↵ run · esc close</div>
            </div>
        </div>
    );
};

export const CommandPalette = ({ commands, onClose, open }: CommandPaletteProps): ReactElement | null =>
    open ? <PaletteDialog commands={commands} onClose={onClose} /> : null;
