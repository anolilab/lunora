import { useEffect, useState } from "react";

/** A palette entry: grouped, labeled, and runnable (GAPS.md ring 3). */
export interface PaletteCommand {
    /** Group header shown above the command (e.g. "Go to", "Actions"). */
    group: string;
    id: string;
    label: string;
    run: () => void;
}

/** Hook: opens the palette on ⌘K / Ctrl-K; returns open-state controls. */
export const useCommandPalette = (): { close: () => void; open: boolean; setOpen: (open: boolean) => void } => {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setOpen((previous) => !previous);
            }
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => {
            globalThis.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    return {
        close: () => {
            setOpen(false);
        },
        open,
        setOpen,
    };
};
