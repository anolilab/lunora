import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { ref?: React.RefObject<ElementRef<typeof TabsPrimitive.List> | null> }) => (
    <TabsPrimitive.List
        className={cn("bg-muted text-muted-foreground inline-flex h-9 items-center justify-center rounded-lg p-1", className)}
        ref={ref}
        {...properties}
    />
);

TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { ref?: React.RefObject<ElementRef<typeof TabsPrimitive.Trigger> | null> }) => (
    <TabsPrimitive.Trigger
        className={cn(
            "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm",
            className,
        )}
        ref={ref}
        {...properties}
    />
);

TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & { ref?: React.RefObject<ElementRef<typeof TabsPrimitive.Content> | null> }) => (
    <TabsPrimitive.Content
        className={cn(
            "ring-offset-background focus-visible:ring-ring mt-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden",
            className,
        )}
        ref={ref}
        {...properties}
    />
);

TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
