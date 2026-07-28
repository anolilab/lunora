import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * shadcn/ui Dialog on `@base-ui` — a centred modal, sibling to `sheet.tsx` (which
 * is the same primitive edge-anchored).
 *
 * Written here rather than copied from `apps/docs`, whose dialog sits on Radix and
 * lucide: pulling it in would put a second primitive library and a second icon set
 * into this app for one component. `packages/studio` has no dialog to copy, and the
 * original design session generated this file with the shadcn CLI, so it is absent
 * from the recovered transcript.
 */
function Dialog({ ...props }: DialogPrimitive.Root.Props): React.ReactElement {
    return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props): React.ReactElement {
    return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props): React.ReactElement {
    return (
        <DialogPrimitive.Backdrop
            className={cn(
                "data-[ending-style]:animate-out data-[starting-style]:animate-in data-[ending-style]:fade-out-0 data-[starting-style]:fade-in-0 fixed inset-0 z-50 bg-black/50",
                className,
            )}
            data-slot="dialog-overlay"
            {...props}
        />
    );
}

function DialogContent({ children, className, ...props }: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }): React.ReactElement {
    const { showCloseButton = true, ...rest } = props as DialogPrimitive.Popup.Props & { showCloseButton?: boolean };

    return (
        <DialogPortal>
            <DialogOverlay />
            <DialogPrimitive.Popup
                className={cn(
                    "bg-background data-[ending-style]:animate-out data-[starting-style]:animate-in data-[ending-style]:fade-out-0 data-[starting-style]:fade-in-0 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg",
                    className,
                )}
                data-slot="dialog-content"
                {...rest}
            >
                {children}
                {showCloseButton ? (
                    <DialogPrimitive.Close
                        className="ring-offset-background focus:ring-ring data-[open]:bg-accent data-[open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                        data-slot="dialog-close"
                    >
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                        <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                ) : null}
            </DialogPrimitive.Popup>
        </DialogPortal>
    );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div className={cn("flex flex-col gap-2 text-center sm:text-left", className)} data-slot="dialog-header" {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
    return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} data-slot="dialog-footer" {...props} />;
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props): React.ReactElement {
    return <DialogPrimitive.Title className={cn("text-lg leading-none font-semibold", className)} data-slot="dialog-title" {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props): React.ReactElement {
    return <DialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} data-slot="dialog-description" {...props} />;
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle };
