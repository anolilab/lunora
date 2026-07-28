import { Logout01Icon, Moon02Icon, Search01Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "@tanstack/react-router";
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
import { Separator } from "@/components/ui/separator";
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
    /** Mono-uppercase context shown before the title (usually the nav group). */
    eyebrow?: ReactNode;
    /** Right-aligned inset-header slot for screen-specific primary actions. */
    headerActions?: ReactNode;
    /** Sidebar header — the org switcher, or a brand mark on the picker. */
    sidebarHeader: ReactNode;
    /** Sidebar body — the grouped nav. */
    sidebarNav: ReactNode;
    /** Slim inset-header title (usually the current section). */
    title: ReactNode;
    /** Signed-in user's email, shown in the sidebar footer menu. */
    userEmail: string;
}

/**
 * The reusable control-plane shell — a shadcn `Sidebar` (org switcher + grouped
 * nav + account menu) beside a `SidebarInset` with a slim titled header. Shared
 * by the org picker (`/orgs`) and the org dashboard (`/orgs/$orgId`), so both
 * read as the same app.
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

    const signOut = async (): Promise<void> => {
        await authClient.signOut();
        await router.invalidate();
    };

    return (
        <TooltipProvider delay={0}>
            <SidebarProvider>
                <Sidebar>
                    <SidebarHeader className="gap-2">
                        {sidebarHeader}
                        {commands.length > 0 ? (
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton
                                        className="text-muted-foreground"
                                        onClick={() => {
                                            palette.setOpen(true);
                                        }}
                                        tooltip="Search (⌘K)"
                                    >
                                        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                                        <span>Find…</span>
                                        <kbd className="pointer-events-none ml-auto inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
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
                                            <SidebarMenuButton className="h-10" size="lg">
                                                <Avatar className="size-6 rounded-md">
                                                    <AvatarFallback className="rounded-md bg-foreground text-[11px] font-semibold text-background">
                                                        {userEmail.charAt(0).toUpperCase()}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <span className="truncate text-sm">{userEmail}</span>
                                            </SidebarMenuButton>
                                        }
                                    />
                                    <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56" side="top">
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
                <SidebarInset>
                    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
                        <SidebarTrigger className="-ml-1 text-muted-foreground" />
                        <Separator className="data-[orientation=vertical]:h-4" orientation="vertical" />
                        <div className="flex min-w-0 items-baseline gap-2">
                            {eyebrow ? (
                                <>
                                    <span className="shrink-0 font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">{eyebrow}</span>
                                    <span aria-hidden className="text-muted-foreground/40">
                                        /
                                    </span>
                                </>
                            ) : null}
                            <span className="truncate text-sm font-medium">{title}</span>
                        </div>
                        <div className="ml-auto flex items-center gap-1">
                            {headerActions}
                            <Button aria-label="Toggle theme" className="text-muted-foreground" onClick={toggleTheme} size="icon" variant="ghost">
                                <HugeiconsIcon className="hidden dark:block" icon={Sun03Icon} strokeWidth={2} />
                                <HugeiconsIcon className="dark:hidden" icon={Moon02Icon} strokeWidth={2} />
                            </Button>
                        </div>
                    </header>
                    <div className="flex flex-1 flex-col gap-6 p-6">{children}</div>
                </SidebarInset>
                {commands.length > 0 ? <CommandPalette commands={commands} onClose={palette.close} open={palette.open} /> : null}
            </SidebarProvider>
        </TooltipProvider>
    );
};
