"use client";

import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link, useLocation } from "@tanstack/react-router";
import type { ClassValue } from "clsx";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
    Book,
    Boxes,
    Bot,
    Clock,
    Database,
    HardDrive,
    Handshake,
    Home,
    HardDriveDownload,
    KeyRound,
    LayoutDashboard,
    Menu,
    Moon,
    Package,
    Rocket,
    ScrollText,
    Search,
    Server,
    Signature,
    Sun,
    Sparkles,
    Wrench,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentPropsWithoutRef, ElementRef, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import lunoraLogoRaw from "@/assets/lunora_logo.svg?raw";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import {
    NavigationMenu,
    NavigationMenuContent,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
    NavigationMenuTrigger,
    navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";
import { cn } from "@/lib/utils";

import { Button } from "../ui/button";

const menu = [
    {
        classes: {
            root: "md:grid-cols-3 [&>li:last-child]:border-b-0 [&>li:last-child]:col-span-full",
        },
        navItems: [
            {
                navItems: [
                    {
                        description: "Define schema, queries, mutations, and actions.",
                        href: "/packages/server",
                        icon: <Server className="size-6" />,
                        title: "Server",
                    },
                    {
                        description: "ShardDO + SessionDO: SQLite, OCC, hibernated subscriptions.",
                        href: "/packages/do",
                        icon: <Database className="size-6" />,
                        title: "Durable Objects",
                    },
                    {
                        description: "Browser SDK with optimistic updates and offline queue.",
                        href: "/packages/client",
                        icon: <Boxes className="size-6" />,
                        title: "Client",
                    },
                ],
                title: "Core",
            },
            {
                navItems: [
                    {
                        description: "useQuery, useMutation, useSubscription, useAuth.",
                        href: "/packages/react",
                        icon: <Sparkles className="size-6" />,
                        title: "React",
                    },
                    {
                        description: "Vite plugin: codegen, type sync, dev server.",
                        href: "/packages/vite",
                        icon: <Wrench className="size-6" />,
                        title: "Vite Plugin",
                    },
                    {
                        description: "TanStack DB binding for live, indexed collections.",
                        href: "/packages/db",
                        icon: <HardDriveDownload className="size-6" />,
                        title: "TanStack DB",
                    },
                ],
                title: "Clients & Tooling",
            },
            {
                navItems: [
                    {
                        description: "Auth on better-auth: email/password, OAuth, passkeys.",
                        href: "/packages/auth",
                        icon: <KeyRound className="size-6" />,
                        title: "Auth",
                    },
                    {
                        description: "Workers AI helper on the Vercel AI SDK.",
                        href: "/packages/ai",
                        icon: <Bot className="size-6" />,
                        title: "AI",
                    },
                    {
                        description: "runAfter / runAt + Cron Triggers via SchedulerDO.",
                        href: "/packages/scheduler",
                        icon: <Clock className="size-6" />,
                        title: "Scheduler",
                    },
                ],
                title: "Add-ons",
            },
            {
                description: "Browse all Lunora packages across every category.",
                href: "/packages",
                icon: <Package className="size-6" />,
                title: "All Packages",
            },
        ],
        navTitle: "Packages",
    },
    {
        classes: {
            root: "grid-cols-2 [&>li:nth-last-child(-n+2)]:border-b-0",
        },
        navItems: [
            {
                navItems: [
                    {
                        description: "Build your first Lunora app in minutes.",
                        href: "/docs/getting-started",
                        icon: <Rocket className="size-6" />,
                        title: "Getting Started",
                    },
                    {
                        description: "Documentation for the Lunora framework.",
                        href: "/docs/",
                        icon: <Book className="size-6" />,
                        title: "Documentation",
                    },
                ],
                title: "Learn",
            },
            {
                navItems: [
                    {
                        description: "New updates and improvements.",
                        href: "/changelog",
                        icon: <ScrollText className="size-6" />,
                        title: "Changelog",
                    },
                    {
                        description: "R2 typed buckets and Studio admin UI.",
                        href: "/packages/storage",
                        icon: <HardDrive className="size-6" />,
                        title: "Storage",
                    },
                ],
                title: "More",
            },
        ],
        navTitle: "Developers",
    },
    {
        classes: {
            root: "md:grid-cols-3 [&>li:nth-last-child(+n)]:border-b-0",
        },
        navItems: [
            {
                description: "Local admin UI for schema, data, logs, and advisors.",
                href: "/packages/studio",
                icon: <LayoutDashboard className="size-6" />,
                title: "Studio",
            },
            {
                description: "Q&A, ideas, and community discussion.",
                href: "https://github.com/anolilab/lunora/discussions",
                icon: <Handshake className="size-6" />,
                title: "Discussions",
            },
            {
                description: "Bug Reports, Feature Requests, Source Code.",
                href: "https://github.com/anolilab/lunora",
                icon: <GitHubLogoIcon className="size-6" />,
                title: "GitHub",
            },
        ],
        navTitle: "Support",
    },
];

const ListItem = ({
    children,
    classes,
    icon,
    ref,
    title,
    ...properties
}: ComponentPropsWithoutRef<"a"> & { classes?: { link?: ClassValue; root?: string }; icon?: ReactNode } & {
    ref?: React.RefObject<ElementRef<"a"> | null>;
}) => {
    const content = (
        <>
            {icon && <div className="flex items-start text-[var(--nav-big-menu-text)]">{icon}</div>}
            <div className="flex flex-col gap-2">
                <h3 className="text-md leading-none font-medium text-[var(--nav-big-menu-text)]">{title}</h3>
                <p className={cn(navigationMenuTriggerStyle, "text-[var(--nav-big-menu-text)]/80 font-mono line-clamp-2 text-sm leading-snug")}>{children}</p>
            </div>
        </>
    );
    const className = cn(
        "focus:bg-[var(--nav-big-menu-text)]/10 flex flex-row gap-3 space-y-1 p-3 leading-none no-underline outline-hidden transition-colors select-none hover:bg-[var(--nav-big-menu-text)]/10",
        classes?.link,
    );

    return (
        <li className={classes?.root}>
            <NavigationMenuLink asChild>
                {properties.href?.startsWith("http") ? (
                    <a
                        className={className}
                        ref={ref}
                        // eslint-disable-next-line react/jsx-props-no-spreading
                        {...properties}
                        rel="noreferrer"
                        target="_blank"
                    >
                        {content}
                    </a>
                ) : (
                    <Link
                        className={className}
                        ref={ref}
                        to={properties.href}
                        // eslint-disable-next-line react/jsx-props-no-spreading
                        {...properties}
                    >
                        {content}
                    </Link>
                )}
            </NavigationMenuLink>
        </li>
    );
};

ListItem.displayName = "ListItem";

const Logo = ({ pathname }: { pathname: string }) => {
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleOutsideClick = (e: MouseEvent) => {
            if (!(e.target as HTMLElement).closest(".logo-context-menu")) {
                setIsOpen(false);
            }
        };

        document.addEventListener("click", handleOutsideClick);

        return () => {
            document.removeEventListener("click", handleOutsideClick);
        };
    }, [isOpen]);

    const handleContextMenu = (e: ReactMouseEvent) => {
        e.preventDefault();
        setIsOpen(true);
    };

    const itemClass =
        "block select-none space-y-1 p-3 leading-none no-underline outline-hidden transition-colors hover:white/10 hover:text-accent-foreground focus:white/10 text-sm flex items-center gap-2";

    return (
        <div className="relative">
            <div className="logo-context-menu" onContextMenu={handleContextMenu}>
                <Link className="group relative z-20 flex items-center gap-2" to={pathname.startsWith("/docs") ? "/docs/$" : "/"}>
                    <LunoraLogo className="h-8 w-8" title="Lunora" />
                    <span className="text-[var(--nav-text-color)] transition-colors hover:[var(--nav-text-color)]/80">
                        {pathname.startsWith("/docs") ? "Documentation" : null}
                    </span>
                </Link>
            </div>
            <ul
                className={cn("hidden bg-red-200 transition-all", {
                    "bg-popover text-popover-foreground absolute top-12 -left-2 z-10 block w-52 gap-2 rounded-md border border-gray-200 p-2 shadow-sm": isOpen,
                })}
            >
                <li>
                    <span className={itemClass} onClick={() => navigator.clipboard.writeText(lunoraLogoRaw)}>
                        <LunoraLogo className="h-4 w-4" title="Lunora" /> Copy Logo as SVG
                    </span>
                </li>
                <li className="py-2">
                    <hr />
                </li>
                <li>
                    <Link className={itemClass} target="_blank" to="/brand">
                        <Signature className="h-4 w-4" /> Brand Guidelines
                    </Link>
                </li>
                <li>
                    <Link className={itemClass} target="_blank" to="/">
                        <Home className="h-4 w-4" /> Home Page
                    </Link>
                </li>
            </ul>
        </div>
    );
};

const SearchButton = () => {
    const { setOpenSearch } = useSearchContext();

    return (
        <button
            className="flex h-8 w-64 cursor-pointer items-center gap-2 rounded-lg border border-[var(--nav-text-color)]/10 bg-white/[0.04] px-3 text-sm text-[var(--nav-text-color)]/50 transition-colors hover:border-[var(--nav-text-color)]/20 hover:bg-white/[0.06]"
            onClick={() => {
                setOpenSearch(true);
            }}
            type="button"
        >
            <Search className="size-3.5" />
            <span>Search...</span>
            <kbd className="ml-auto rounded border border-[var(--nav-text-color)]/10 px-1.5 py-0.5 text-xs text-[var(--nav-text-color)]/30">/</kbd>
        </button>
    );
};

const ThemeToggle = () => {
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return <div className="size-8" />;
    }

    return (
        <button
            aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-[var(--nav-text-color)]/10 text-[var(--nav-text-color)]/70 transition-colors hover:bg-white/[0.06] hover:text-[var(--nav-text-color)]"
            onClick={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark");
            }}
            type="button"
        >
            {resolvedTheme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
    );
};

const Navbar = () => {
    const { pathname } = useLocation();
    const navReference = useRef(null);
    const [scrolled, setScrolled] = useState(false);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    useEffect(() => {
        let ticking = false;

        const handleScroll = () => {
            if (ticking) {
                return;
            }

            ticking = true;

            requestAnimationFrame(() => {
                const sections = document.querySelectorAll("section[data-nav-theme]");

                let currentTheme = "dark"; // default

                for (const section of sections) {
                    const rect = section.getBoundingClientRect();

                    if (rect.top <= 0 && rect.bottom > 0) {
                        currentTheme = (section as HTMLElement).dataset.navTheme ?? "dark";
                    }
                }

                if (navReference.current) {
                    (navReference.current as HTMLDivElement).dataset.theme = currentTheme;
                }

                setScrolled(window.scrollY > 10);
                ticking = false;
            });
        };

        window.addEventListener("scroll", handleScroll, { passive: true });

        handleScroll(); // set on mount

        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, [navReference]);

    return (
        <div className={cn("flex fixed top-0 z-20 w-full gap-8 transition-all duration-300", { "top-5": scrolled })} data-theme="dark" ref={navReference}>
            <NavigationMenu className="bg-opacity-25 mx-auto flex gap-5 rounded-t-md px-4 py-2 shadow-sm backdrop-blur-lg backdrop-filter">
                <div className="flex items-center gap-4">
                    <Logo pathname={pathname} />
                </div>
                <NavigationMenuList className="hidden lg:flex">
                    {menu.map((item) => (
                        <NavigationMenuItem key={item.navTitle}>
                            <NavigationMenuTrigger>{item.navTitle}</NavigationMenuTrigger>
                            <NavigationMenuContent>
                                <ul
                                    className={cn(
                                        "grid w-full md:w-[840px] [&>li]:border-[var(--nav-big-menu-border)] [&>li:not(:last-child)]:border-b [&>li:not(:last-child)]:border-r",
                                        item?.classes?.root,
                                    )}
                                >
                                    {item.navItems.map((item: any, index: number) => {
                                        if (item.navItems) {
                                            return (
                                                <li key={item.title + index}>
                                                    <h3 className="text-md leading-none font-medium text-[var(--nav-big-menu-text)] p-3 border-b border-[var(--nav-big-menu-border)] h-10">
                                                        {item.title}
                                                    </h3>
                                                    <ul className="flex flex-col gap-0">
                                                        {item.navItems.map((item: any, index2: number) => (
                                                            <ListItem href={item.href} icon={item.icon} key={item.title + index + index2} title={item.title}>
                                                                {item.description}
                                                            </ListItem>
                                                        ))}
                                                    </ul>
                                                </li>
                                            );
                                        }

                                        return (
                                            <ListItem href={item.href} icon={item.icon} key={item.title + index} title={item.title}>
                                                {item.description}
                                            </ListItem>
                                        );
                                    })}
                                </ul>
                            </NavigationMenuContent>
                        </NavigationMenuItem>
                    ))}
                </NavigationMenuList>
                <SearchButton />
                <ThemeToggle />
                <a className="text-white transition-colors hover:text-white/80" href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                    <GitHubLogoIcon className="size-4 fill-[var(--nav-text-color)]" title="Star us on GitHub" />
                </a>
                {!pathname.startsWith("/docs") && (
                    <Link className="hidden lg:block bg-coal py-1 px-2 text-white transition-colors hover:text-white/80 rounded-[9px]" to="/docs/$">
                        Documentation
                    </Link>
                )}
                <Button
                    className="lg:hidden cursor-pointer"
                    onClick={() => {
                        setIsMobileMenuOpen(!isMobileMenuOpen);
                    }}
                    variant="ghost"
                >
                    <Menu className="size-4" />
                </Button>
            </NavigationMenu>
        </div>
    );
};

export default Navbar;
