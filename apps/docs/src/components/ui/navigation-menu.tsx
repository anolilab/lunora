import { cva } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { NavigationMenu as NavigationMenuPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "@/lib/utils";

const NavigationMenu = ({
    children,
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Root> & { ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.Root> | null> }) => (
    <NavigationMenuPrimitive.Root className={cn("relative z-10 flex max-w-max flex-1 items-center justify-center", className)} ref={ref} {...properties}>
        {children}
        <NavigationMenuViewport />
    </NavigationMenuPrimitive.Root>
);

NavigationMenu.displayName = NavigationMenuPrimitive.Root.displayName;

const NavigationMenuList = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.List> & { ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.List> | null> }) => (
    <NavigationMenuPrimitive.List className={cn("group flex flex-1 list-none items-center justify-center space-x-1", className)} ref={ref} {...properties} />
);

NavigationMenuList.displayName = NavigationMenuPrimitive.List.displayName;

const NavigationMenuItem = NavigationMenuPrimitive.Item;

const navigationMenuTriggerStyle = cva(
    "group text-[var(--nav-text-color)] inline-flex h-9 w-max items-center justify-center px-4 py-2 text-sm font-medium transition-colors duration-300 hover:text-[var(--nav-text-color)]/80 focus:text-[var(--nav-text-color)]/80 disabled:pointer-events-none disabled:opacity-50 data-active:bg-white/20 data-[state=open]:bg-white/20",
);

const NavigationMenuTrigger = ({
    children,
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Trigger> & { ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.Trigger> | null> }) => (
    <NavigationMenuPrimitive.Trigger className={cn(navigationMenuTriggerStyle(), "group", className)} ref={ref} {...properties}>
        {children} <ChevronDown aria-hidden="true" className="relative top-[1px] ml-1 h-3 w-3 group-data-[state=open]:rotate-180" />
    </NavigationMenuPrimitive.Trigger>
);

NavigationMenuTrigger.displayName = NavigationMenuPrimitive.Trigger.displayName;

const NavigationMenuContent = ({
    children,
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Content> & { ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.Content> | null> }) => (
    <NavigationMenuPrimitive.Content
        className={cn(
            "p-0 data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 top-0 left-0 w-full md:absolute md:w-auto",
            className,
        )}
        ref={ref}
        {...properties}
    >
        <div className="flex flex-col gap-0 ml-1 mt-1 mb-2 mr-2 border" style={{ borderColor: "var(--nav-big-menu-border)" }}>
            {children}
        </div>
    </NavigationMenuPrimitive.Content>
);

NavigationMenuContent.displayName = NavigationMenuPrimitive.Content.displayName;

const NavigationMenuLink = NavigationMenuPrimitive.Link;

const NavigationMenuViewport = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Viewport> & {
    ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.Viewport> | null>;
}) => (
    <div className={cn("absolute top-full left-0 flex justify-center")}>
        <NavigationMenuPrimitive.Viewport
            className={cn(
                "origin-top-center bg-[var(--nav-big-menu-bg)] transition-all duration-300 rounded-b-md text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-90 relative mt-1.5 h-(--radix-navigation-menu-viewport-height) w-full overflow-hidden border border-[var(--nav-big-menu-border)] shadow-sm md:w-(--radix-navigation-menu-viewport-width)",
                className,
            )}
            ref={ref}
            {...properties}
        />
    </div>
);

NavigationMenuViewport.displayName = NavigationMenuPrimitive.Viewport.displayName;

const NavigationMenuIndicator = ({
    className,
    ref,
    ...properties
}: ComponentPropsWithoutRef<typeof NavigationMenuPrimitive.Indicator> & {
    ref?: React.RefObject<ElementRef<typeof NavigationMenuPrimitive.Indicator> | null>;
}) => (
    <NavigationMenuPrimitive.Indicator
        className={cn(
            "data-[state=visible]:animate-in data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:fade-in top-full z-1 flex h-1.5 items-end justify-center overflow-hidden",
            className,
        )}
        ref={ref}
        {...properties}
    >
        <div className="bg-border relative top-[60%] h-2 w-2 rotate-45 shadow-md" />
    </NavigationMenuPrimitive.Indicator>
);

NavigationMenuIndicator.displayName = NavigationMenuPrimitive.Indicator.displayName;

export {
    NavigationMenu,
    NavigationMenuContent,
    NavigationMenuIndicator,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
    NavigationMenuTrigger,
    navigationMenuTriggerStyle,
    NavigationMenuViewport,
};
