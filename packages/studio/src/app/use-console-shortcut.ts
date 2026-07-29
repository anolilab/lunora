import { useEffect } from "react";

/**
 * Bind Ctrl+` to a toggle for the operation console.
 *
 * Its own hook because the guard list is the whole point and it deserves to be
 * read on its own: the console is a developer affordance layered over pages that
 * are mostly text inputs, so the shortcut has to be inert everywhere the operator
 * could plausibly be typing.
 *
 * A `undefined` toggle (the console provider is not mounted) binds nothing.
 */
const useConsoleShortcut = (toggleConsole: (() => void) | undefined): void => {
    useEffect(() => {
        if (toggleConsole === undefined) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            // Ctrl+` only — NOT ⌘`, which macOS owns as "cycle this app's
            // windows" — with no other modifier, ignoring auto-repeat, and never
            // while the operator is typing (the SQL editor is a full-page
            // textarea, and ` is a legal character in it).
            if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.key !== "`") {
                return;
            }

            const { target } = event;

            if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) {
                return;
            }

            event.preventDefault();
            toggleConsole();
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => {
            globalThis.removeEventListener("keydown", onKeyDown);
        };
    }, [toggleConsole]);
};

export { useConsoleShortcut };
