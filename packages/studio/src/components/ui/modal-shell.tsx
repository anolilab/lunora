import type { CSSProperties, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";
import { useCallback } from "react";

import { cn } from "../../lib/utils";

interface ModalShellProps {
    /** Extra classes merged onto the panel (e.g. a custom width). */
    readonly className?: string;
    readonly children: ReactNode;
    /** Accessible label for the dialog/drawer panel. */
    readonly label: string;
    /** Dismiss the modal (backdrop click, Escape, or a close control inside). */
    readonly onClose: () => void;
    /** `data-testid` for the panel element. */
    readonly panelTestId?: string;
    /** `data-testid` for the backdrop element. */
    readonly testId?: string;
    /** `"drawer"` slides in from the right (full height); `"dialog"` floats centered near the top. */
    readonly variant: "dialog" | "drawer";
}

const OVERLAY_BASE: CSSProperties = {
    background: "rgba(0,0,0,0.2)",
    bottom: 0,
    display: "flex",
    left: 0,
    position: "fixed",
    right: 0,
    top: 0,
    zIndex: 1000,
};

const OVERLAY_BY_VARIANT: Record<ModalShellProps["variant"], CSSProperties> = {
    dialog: { ...OVERLAY_BASE, justifyContent: "center", paddingTop: "10vh" },
    drawer: { ...OVERLAY_BASE, justifyContent: "flex-end" },
};

const PANEL_BY_VARIANT: Record<ModalShellProps["variant"], string> = {
    dialog: "flex h-fit w-[min(28rem,92vw)] flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-xl",
    drawer: "flex h-full w-[min(34rem,100vw)] flex-col gap-4 overflow-auto border-l border-border bg-background p-4 shadow-xl",
};

/**
 * Shared overlay + dismiss shell for the studio's modals. Owns the fixed
 * backdrop, the layout (right-drawer vs centered-dialog), and the canonical
 * dismiss behaviour — backdrop click and Escape — so individual modals don't
 * re-implement it. Replaces the copy-pasted overlay/dismiss blocks that had
 * accreted across the data-grid cell dialog, row drawer, and auth modals.
 */
export const ModalShell = ({ className, children, label, onClose, panelTestId, testId, variant }: ModalShellProps): ReactElement => {
    const onOverlayClick = useCallback(
        (event: MouseEvent<HTMLDivElement>): void => {
            if (event.target === event.currentTarget) {
                onClose();
            }
        },
        [onClose],
    );

    const onOverlayKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>): void => {
            if (event.key === "Escape") {
                onClose();
            }
        },
        [onClose],
    );

    return (
        <div data-testid={testId} onClick={onOverlayClick} onKeyDown={onOverlayKeyDown} role="presentation" style={OVERLAY_BY_VARIANT[variant]}>
            <div aria-label={label} className={cn(PANEL_BY_VARIANT[variant], className)} data-testid={panelTestId} role="dialog">
                {children}
            </div>
        </div>
    );
};

export type { ModalShellProps };
