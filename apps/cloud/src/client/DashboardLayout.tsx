import { Logout01Icon, Moon02Icon, Search01Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import { resetOperator } from "./analytics";
import { authClient } from "./auth-client";
import { CommandPalette } from "./CommandPalette";
import type { PaletteCommand } from "./use-command-palette";
import { useCommandPalette } from "./use-command-palette";

/** Flip the Night/Ivory theme by toggling the `.dark` class on the document root and persisting it. */
const toggleTheme = (): void => {
    const isDark = document.documentElement.classList.toggle("dark");

    try {
        localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
        /* storage unavailable — the class flip still applies for this session */
    }
};

/** Stable empty default for `commands` — a fresh `[]` literal per render trips react-perf/react-x. */
const NO_COMMANDS: PaletteCommand[] = [];

interface DashboardLayoutProps {
    children: ReactNode;
    /** ⌘K palette entries. When non-empty, a "Find" search shows in the sidebar. */
    commands?: PaletteCommand[];
    /** Breadcrumb section shown before the title (usually the nav group, with its icon). */
    eyebrow?: ReactNode;
    /** Right-aligned inset-header slot for screen-specific primary actions. */
    headerActions?: ReactNode;
    /** Sidebar header — the org switcher, or a brand mark on the picker. */
    sidebarHeader: ReactNode;
    /** Sidebar body — the grouped nav. */
    sidebarNav: ReactNode;
    /** Breadcrumb page — the current section. */
    title: ReactNode;
    /** Signed-in user's email, shown in the sidebar footer menu. */
    userEmail: string;
}

/**
 * The reusable control-plane shell: a full-viewport layout holding a shadcn `Sidebar` (org switcher + grouped nav + account menu)
 * as an icon rail that slides open (trigger or ⌘B), beside a `SidebarInset`
 * content panel with a "Section / Page" breadcrumb header. On mobile the rail
 * becomes a sheet from the left.
 */
export const DashboardLayout = ({
    children,
    commands = NO_COMMANDS,
    eyebrow,
    headerActions,
    sidebarHeader,
    sidebarNav,
    title,
    userEmail,
}: DashboardLayoutProps): ReactElement => {
    const router = useRouter();
    const palette = useCommandPalette();
    // Read off the request cookie in `_authed`'s `beforeLoad`, so the server and the
    // first client pass render the same rail state.
    const sidebarOpen = useRouteContext({ from: "/_authed", select: (context) => context.sidebarOpen });

    const signOut = async (): Promise<void> => {
        // Before the sign-out, not after: `router.invalidate()` can unmount this
        // tree, and an operator who is still attached in PostHog after signing
        // out attributes the next person on a shared machine to them.
        resetOperator();
        await authClient.signOut();
        await router.invalidate();
    };

    return (
        <TooltipProvider delay={0}>
            <SidebarProvider className="h-svh min-h-0 md:p-3" defaultOpen={sidebarOpen}>
                {/* The window: the rail and the inset content panel sit inside one rounded frame. */}
                <div className="relative isolate flex h-full w-full overflow-hidden md:rounded-3xl md:border md:border-border md:bg-card md:shadow-card">
                    {/* `absolute h-full` (merged over the primitive's `fixed h-svh`) pins
                        the rail to this layout rather than the viewport edge; `z-20`
                        lifts it over the sticky header so the org switcher, which opens
                        out to the right of the collapsed rail, is not painted under it. */}
                    <Sidebar className="absolute z-20 h-full" collapsible="icon" variant="inset">
                        <SidebarHeader className="gap-2">
                            {sidebarHeader}
                            {commands.length > 0 ? (
                                <SidebarMenu>
                                    <SidebarMenuItem>
                                        <SidebarMenuButton
                                            className="text-sidebar-foreground"
                                            onClick={() => {
                                                palette.setOpen(true);
                                            }}
                                            tooltip="Search (⌘K)"
                                        >
                                            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                                            <span className="group-data-[collapsible=icon]:sr-only">Find…</span>
                                            <kbd className="pointer-events-none ml-auto inline-flex group-data-[collapsible=icon]:hidden h-5 items-center rounded-md border bg-muted/60 px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                                                ⌘K
                                            </kbd>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            ) : null}
                        </SidebarHeader>
                        <SidebarContent>{sidebarNav}</SidebarContent>
                        <SidebarFooter>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <DropdownMenu>
                                        {/* `render`, not `asChild`: this shadcn set is built on @base-ui, whose
                                            merge-props API replaces Radix's asChild slot. */}
                                        <DropdownMenuTrigger
                                            render={
                                                <SidebarMenuButton className="h-12 group-data-[collapsible=icon]:justify-center" size="lg">
                                                    <Avatar className="size-8 shadow-(--avatar-shadow)">
                                                        <AvatarFallback className="bg-(image:--avatar-gradient) text-[11px] font-semibold text-white">
                                                            {userEmail.charAt(0).toUpperCase()}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span className="truncate text-[13px]">{userEmail}</span>
                                                </SidebarMenuButton>
                                            }
                                        />
                                        <DropdownMenuContent align="start" className="min-w-56" side="top">
                                            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{userEmail}</DropdownMenuLabel>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuGroup>
                                                <DropdownMenuItem
                                                    onSelect={() => {
                                                        void signOut();
                                                    }}
                                                >
                                                    <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
                                                    Sign out
                                                </DropdownMenuItem>
                                            </DropdownMenuGroup>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarFooter>
                    </Sidebar>
                    <SidebarInset className="min-h-0 overflow-y-auto">
                        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 bg-background/80 px-4 backdrop-blur-md md:px-6">
                            <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
                            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5 text-[15px]">
                                {eyebrow ? (
                                    <>
                                        <span className="flex shrink-0 items-center gap-2 text-muted-foreground [&_svg]:size-[18px]">{eyebrow}</span>
                                        <span aria-hidden className="text-muted-foreground/40">
                                            /
                                        </span>
                                    </>
                                ) : null}
                                <span aria-current="page" className="truncate font-medium text-foreground">
                                    {title}
                                </span>
                            </nav>
                            <div className="ml-auto flex items-center gap-1">
                                {headerActions}
                                <Button aria-label="Toggle theme" className="text-muted-foreground" onClick={toggleTheme} size="icon" variant="ghost">
                                    <HugeiconsIcon className="hidden dark:block" icon={Sun03Icon} strokeWidth={2} />
                                    <HugeiconsIcon className="dark:hidden" icon={Moon02Icon} strokeWidth={2} />
                                </Button>
                            </div>
                        </header>
                        <div className="flex flex-1 flex-col gap-6 px-4 pt-2 pb-6 md:px-6">{children}</div>
                    </SidebarInset>
                </div>
                {commands.length > 0 ? <CommandPalette commands={commands} onClose={palette.close} open={palette.open} /> : null}
            </SidebarProvider>
        </TooltipProvider>
    );
};
