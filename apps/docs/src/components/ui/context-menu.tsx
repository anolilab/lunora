import { CheckIcon, ChevronRightIcon, DotFilledIcon } from "@radix-ui/react-icons";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuGroup = ContextMenuPrimitive.Group;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuSub = ContextMenuPrimitive.Sub;

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const ContextMenuSubTrigger = ({
    children,
    className,
    inset,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
} & { ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.SubTrigger> | null> }) => (
    <ContextMenuPrimitive.SubTrigger
        className={cn(
            "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none",
            inset && "pl-8",
            className,
        )}
        ref={ref}
        {...properties}
    >
        {children}
        <ChevronRightIcon className="ml-auto h-4 w-4" />
    </ContextMenuPrimitive.SubTrigger>
);

ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = ({
    className,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> & {
    ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.SubContent> | null>;
}) => (
    <ContextMenuPrimitive.SubContent
        className={cn(
            "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg",
            className,
        )}
        ref={ref}
        {...properties}
    />
);

ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = ({
    className,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
    ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Content> | null>;
}) => (
    <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
            className={cn(
                "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-md",
                className,
            )}
            ref={ref}
            {...properties}
        />
    </ContextMenuPrimitive.Portal>
);

ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = ({
    className,
    inset,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
} & { ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Item> | null> }) => (
    <ContextMenuPrimitive.Item
        className={cn(
            "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
            inset && "pl-8",
            className,
        )}
        ref={ref}
        {...properties}
    />
);

ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = ({
    checked,
    children,
    className,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & {
    ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem> | null>;
}) => (
    <ContextMenuPrimitive.CheckboxItem
        checked={checked}
        className={cn(
            "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
            className,
        )}
        ref={ref}
        {...properties}
    >
        <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            <ContextMenuPrimitive.ItemIndicator>
                <CheckIcon className="h-4 w-4" />
            </ContextMenuPrimitive.ItemIndicator>
        </span>
        {children}
    </ContextMenuPrimitive.CheckboxItem>
);

ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuRadioItem = ({
    children,
    className,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem> & {
    ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.RadioItem> | null>;
}) => (
    <ContextMenuPrimitive.RadioItem
        className={cn(
            "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
            className,
        )}
        ref={ref}
        {...properties}
    >
        <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            <ContextMenuPrimitive.ItemIndicator>
                <DotFilledIcon className="h-4 w-4 fill-current" />
            </ContextMenuPrimitive.ItemIndicator>
        </span>
        {children}
    </ContextMenuPrimitive.RadioItem>
);

ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

const ContextMenuLabel = ({
    className,
    inset,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
} & { ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Label> | null> }) => (
    <ContextMenuPrimitive.Label className={cn("text-foreground px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)} ref={ref} {...properties} />
);

ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = ({
    className,
    ref,
    ...properties
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator> & {
    ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Separator> | null>;
}) => <ContextMenuPrimitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} ref={ref} {...properties} />;

ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({ className, ...properties }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span className={cn("text-muted-foreground ml-auto text-xs tracking-widest", className)} {...properties} />
);

ContextMenuShortcut.displayName = "ContextMenuShortcut";

export {
    ContextMenu,
    ContextMenuCheckboxItem,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuPortal,
    ContextMenuRadioGroup,
    ContextMenuRadioItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
};
