"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const Dialog = ({ ...properties }: React.ComponentProps<typeof DialogPrimitive.Root>) => <DialogPrimitive.Root data-slot="dialog" {...properties} />;

const DialogTrigger = ({ ...properties }: React.ComponentProps<typeof DialogPrimitive.Trigger>) => (
    <DialogPrimitive.Trigger data-slot="dialog-trigger" {...properties} />
);

const DialogPortal = ({ ...properties }: React.ComponentProps<typeof DialogPrimitive.Portal>) => (
    <DialogPrimitive.Portal data-slot="dialog-portal" {...properties} />
);

const DialogClose = ({ ...properties }: React.ComponentProps<typeof DialogPrimitive.Close>) => (
    <DialogPrimitive.Close data-slot="dialog-close" {...properties} />
);

const DialogOverlay = ({ className, ...properties }: React.ComponentProps<typeof DialogPrimitive.Overlay>) => (
    <DialogPrimitive.Overlay
        className={cn(
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
            className,
        )}
        data-slot="dialog-overlay"
        {...properties}
    />
);

const DialogContent = ({
    children,
    className,
    showCloseButton = true,
    ...properties
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
}) => (
    <DialogPortal data-slot="dialog-portal">
        <DialogOverlay />
        <DialogPrimitive.Content
            className={cn(
                "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
                className,
            )}
            data-slot="dialog-content"
            {...properties}
        >
            {children}
            {showCloseButton && (
                <DialogPrimitive.Close
                    className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
                    data-slot="dialog-close"
                >
                    <XIcon />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            )}
        </DialogPrimitive.Content>
    </DialogPortal>
);

const DialogHeader = ({ className, ...properties }: React.ComponentProps<"div">) => (
    <div className={cn("flex flex-col gap-2 text-center sm:text-left", className)} data-slot="dialog-header" {...properties} />
);

const DialogFooter = ({ className, ...properties }: React.ComponentProps<"div">) => (
    <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} data-slot="dialog-footer" {...properties} />
);

const DialogTitle = ({ className, ...properties }: React.ComponentProps<typeof DialogPrimitive.Title>) => (
    <DialogPrimitive.Title className={cn("text-lg leading-none font-semibold", className)} data-slot="dialog-title" {...properties} />
);

const DialogDescription = ({ className, ...properties }: React.ComponentProps<typeof DialogPrimitive.Description>) => (
    <DialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} data-slot="dialog-description" {...properties} />
);

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger };
