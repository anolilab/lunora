import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const ScrollArea = ({ children, className, ...properties }: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) => (
    <ScrollAreaPrimitive.Root className={cn("relative", className)} data-slot="scroll-area" {...properties}>
        <ScrollAreaPrimitive.Viewport
            className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
            data-slot="scroll-area-viewport"
        >
            {children}
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
        <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
);

const ScrollBar = ({ className, orientation = "vertical", ...properties }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) => (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
        className={cn(
            "flex touch-none p-px transition-colors select-none",
            orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
            orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
            className,
        )}
        data-slot="scroll-area-scrollbar"
        orientation={orientation}
        {...properties}
    >
        <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" data-slot="scroll-area-thumb" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
);

export { ScrollArea, ScrollBar };
