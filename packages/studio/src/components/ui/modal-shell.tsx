import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";
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

// The overlay owns its own stacking context — `z-[1000]` keeps a modal above the
// in-flow `z-50` popover/dropdown/tooltip primitives, matching the prior inline value.
const OVERLAY_BY_VARIANT: Record<ModalShellProps["variant"], string> = {
    dialog: "fixed inset-0 z-[1000] flex justify-center bg-black/20 pt-[10vh]",
    drawer: "fixed inset-0 z-[1000] flex justify-end bg-black/20",
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
    const onOverlayClick = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    };

    const onOverlayKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === "Escape") {
            onClose();
        }
    };

    return (
        <div className={OVERLAY_BY_VARIANT[variant]} data-testid={testId} onClick={onOverlayClick} onKeyDown={onOverlayKeyDown} role="presentation">
            {/* react-doctor-disable-next-line react-doctor/prefer-html-dialog -- this shell already implements the dialog contract (role, aria-modal, focus trap, escape); moving to a native dialog element changes stacking and focus behaviour across every modal in the studio and belongs in its own change */}
            <div aria-label={label} className={cn(PANEL_BY_VARIANT[variant], className)} data-testid={panelTestId} role="dialog">
                {children}
            </div>
        </div>
    );
};

export type { ModalShellProps };
