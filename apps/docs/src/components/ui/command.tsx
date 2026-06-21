import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import * as React from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const Command = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive>) => (
    <CommandPrimitive
        className={cn("bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden", className)}
        data-slot="command"
        {...properties}
    />
);

const CommandDialog = ({
    children,
    className,
    description = "Search for a command to run...",
    showCloseButton = true,
    title = "Command Palette",
    ...properties
}: React.ComponentProps<typeof Dialog> & {
    className?: string;
    description?: string;
    showCloseButton?: boolean;
    title?: string;
}) => (
    <Dialog {...properties}>
        <DialogHeader className="sr-only">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogContent className={cn("overflow-hidden p-0", className)} showCloseButton={showCloseButton}>
            <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
                {children}
            </Command>
        </DialogContent>
    </Dialog>
);

const CommandInput = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive.Input>) => (
    <div className="flex h-9 items-center gap-2 border-b px-3" data-slot="command-input-wrapper">
        <SearchIcon className="size-4 shrink-0 opacity-50" />
        <CommandPrimitive.Input
            className={cn(
                "placeholder:text-muted-foreground flex h-10 w-full bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            data-slot="command-input"
            {...properties}
        />
    </div>
);

const CommandList = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive.List>) => (
    <CommandPrimitive.List className={cn("max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto", className)} data-slot="command-list" {...properties} />
);

const CommandEmpty = ({ ...properties }: React.ComponentProps<typeof CommandPrimitive.Empty>) => (
    <CommandPrimitive.Empty className="py-6 text-center text-sm" data-slot="command-empty" {...properties} />
);

const CommandGroup = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive.Group>) => (
    <CommandPrimitive.Group
        className={cn(
            "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
            className,
        )}
        data-slot="command-group"
        {...properties}
    />
);

const CommandSeparator = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive.Separator>) => (
    <CommandPrimitive.Separator className={cn("bg-border -mx-1 h-px", className)} data-slot="command-separator" {...properties} />
);

const CommandItem = ({ className, ...properties }: React.ComponentProps<typeof CommandPrimitive.Item>) => (
    <CommandPrimitive.Item
        className={cn(
            "data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-white [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
            className,
        )}
        data-slot="command-item"
        {...properties}
    />
);

const CommandShortcut = ({ className, ...properties }: React.ComponentProps<"span">) => (
    <span className={cn("text-muted-foreground ml-auto text-xs tracking-widest", className)} data-slot="command-shortcut" {...properties} />
);

export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut };
