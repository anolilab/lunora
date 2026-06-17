"use client";

import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link, useLocation } from "@tanstack/react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
    Book,
    Bot,
    Boxes,
    ChevronRight,
    Clock,
    Database,
    Handshake,
    HardDrive,
    HardDriveDownload,
    Home,
    KeyRound,
    LayoutDashboard,
    Menu,
    Package,
    Rocket,
    ScrollText,
    Search,
    Server,
    Signature,
    Sparkles,
    Wrench,
    X,
} from "lucide-react";
import type { ElementRef, MouseEvent as ReactMouseEvent, ReactNode } from "react";
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
} from "@/components/ui/navigation-menu";
import stats from "@/data/stats.json";
import { cn } from "@/lib/utils";

import { Button } from "../ui/button";

const formatStars = (count: number): string => {
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    }

    return count > 0 ? String(count) : "GitHub";
};

interface NavLeaf {
    description: string;
    href: string;
    icon: ReactNode;
    title: string;
}

interface NavGroup {
    navItems: NavLeaf[];
    title: string;
}

interface NavColumn {
    classes: { root: string };
    navItems: (NavGroup | NavLeaf)[];
    navTitle: string;
}

const isNavGroup = (item: NavGroup | NavLeaf): item is NavGroup => "navItems" in item;

const menu: NavColumn[] = [
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
    href,
    icon,
    ref,
    title,
}: {
    children: ReactNode;
    href: string;
    icon?: ReactNode;
    ref?: React.RefObject<ElementRef<"a"> | null>;
    title: string;
}) => {
    const content = (
        <>
            {icon && (
                <span className="flex size-9 shrink-0 items-center justify-center border border-[var(--nav-big-menu-text)]/10 text-[var(--nav-big-menu-text)]/70 [&_svg]:size-4.5">
                    {icon}
                </span>
            )}
            <span className="flex flex-col gap-1">
                <span className="text-sm leading-none font-medium text-[var(--nav-big-menu-text)]">{title}</span>
                <span className="line-clamp-1 text-xs leading-snug text-[var(--nav-big-menu-text)]/50">{children}</span>
            </span>
        </>
    );
    const className =
        "flex items-center gap-3 p-2.5 no-underline outline-hidden transition-colors select-none hover:bg-[var(--nav-big-menu-text)]/[0.06] focus:bg-[var(--nav-big-menu-text)]/[0.06]";

    return (
        <li>
            <NavigationMenuLink asChild>
                {href.startsWith("http") ? (
                    <a className={className} href={href} ref={ref} rel="noreferrer" target="_blank">
                        {content}
                    </a>
                ) : (
                    <Link className={className} ref={ref} to={href}>
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

        const handleOutsideClick = (event: MouseEvent) => {
            if (!(event.target as HTMLElement).closest(".logo-context-menu")) {
                setIsOpen(false);
            }
        };

        document.addEventListener("click", handleOutsideClick);

        return () => {
            document.removeEventListener("click", handleOutsideClick);
        };
    }, [isOpen]);

    const handleContextMenu = (event: ReactMouseEvent) => {
        event.preventDefault();
        setIsOpen(true);
    };

    const itemClass =
        "flex items-center gap-2 select-none p-3 text-sm leading-none text-white/80 no-underline transition-colors hover:bg-white/10 hover:text-white";

    return (
        <div className="relative">
            <div className="logo-context-menu" onContextMenu={handleContextMenu}>
                <Link className="group relative z-20 flex items-center gap-2.5" to={pathname.startsWith("/docs") ? "/docs/$" : "/"}>
                    <LunoraLogo className="h-7 w-7" title="Lunora" />
                    <span className="text-[15px] font-semibold tracking-tight text-[var(--nav-text-color)]">Lunora</span>
                </Link>
            </div>
            {isOpen && (
                <ul className="logo-context-menu absolute top-12 -left-2 z-10 block w-52 border border-white/10 bg-[hsl(0_0%_10%)] p-2 text-white shadow-xl">
                    <li>
                        <button className={cn(itemClass, "w-full cursor-pointer")} onClick={() => navigator.clipboard.writeText(lunoraLogoRaw)} type="button">
                            <LunoraLogo className="h-4 w-4" title="Lunora" /> Copy Logo as SVG
                        </button>
                    </li>
                    <li className="py-1">
                        <hr className="border-white/10" />
                    </li>
                    <li>
                        <Link className={itemClass} target="_blank" to="/brand">
                            <Signature className="h-4 w-4" /> Brand Guidelines
                        </Link>
                    </li>
                    <li>
                        <Link className={itemClass} to="/">
                            <Home className="h-4 w-4" /> Home Page
                        </Link>
                    </li>
                </ul>
            )}
        </div>
    );
};

const SearchButton = () => {
    const { setOpenSearch } = useSearchContext();

    return (
        <Button
            aria-label="Search"
            className="size-11 rounded-none border-b bg-white"
            onClick={() => {
                setOpenSearch(true);
            }}
            size="icon"
            variant="default"
        >
            <Search className="size-4" />
        </Button>
    );
};

const Navbar = () => {
    const { pathname } = useLocation();
    const navReference = useRef<HTMLElement>(null);
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
                    navReference.current.dataset.theme = currentTheme;
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
    }, []);

    return (
        <header className="fixed inset-x-0 top-0 z-100 flex items-center pt-2.5" data-theme="dark" ref={navReference}>
            <div className="container mx-auto flex items-center gap-30 transition-all duration-300">
                <div className="relative z-10 flex h-11 flex-1 items-center justify-between bg-foreground  pr-2 pl-6 text-background [--nav-text-color:var(--background)]">
                    <Logo pathname={pathname} />
                    <nav aria-label="Primary navigation" className="hidden h-full items-center gap-1 lg:flex">
                        <NavigationMenu className="h-full">
                            <NavigationMenuList>
                                {menu.map((item) => (
                                    <NavigationMenuItem key={item.navTitle}>
                                        <NavigationMenuTrigger>{item.navTitle}</NavigationMenuTrigger>
                                        <NavigationMenuContent>
                                            <ul className="grid w-[460px] grid-cols-2 gap-0.5">
                                                {item.navItems
                                                    .flatMap((navItem) => (isNavGroup(navItem) ? navItem.navItems : [navItem]))
                                                    .map((leaf) => (
                                                        <ListItem href={leaf.href} icon={leaf.icon} key={leaf.title} title={leaf.title}>
                                                            {leaf.description}
                                                        </ListItem>
                                                    ))}
                                            </ul>
                                        </NavigationMenuContent>
                                    </NavigationMenuItem>
                                ))}
                            </NavigationMenuList>
                        </NavigationMenu>
                    </nav>
                </div>

                <nav aria-label="Actions" className="hidden items-center gap-1 lg:flex">
                    <SearchButton />
                    <Button
                        aria-label={`GitHub repository (${formatStars(stats.stars)} stars)`}
                        asChild
                        className="h-11 gap-1.5 rounded-none px-5 text-sm font-semibold border-b bg-white"
                        variant="default"
                    >
                        <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                            <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                            <span className="font-mono tabular-nums">{formatStars(stats.stars)}</span>
                        </a>
                    </Button>
                    <Button asChild className="h-11 gap-1 rounded-none px-6 text-sm font-semibold border-b bg-white" variant="default">
                        <Link to="/docs/$">
                            Get started
                            <ChevronRight className="size-4" />
                        </Link>
                    </Button>
                </nav>

                <button
                    aria-label="Open menu"
                    className="flex size-11 items-center justify-center bg-foreground text-background transition-colors hover:bg-foreground/90 lg:hidden"
                    onClick={() => {
                        setIsMobileMenuOpen(true);
                    }}
                    type="button"
                >
                    <Menu className="size-5" />
                </button>
            </div>

            {isMobileMenuOpen && (
                <div className="fixed inset-0 z-[110] overflow-y-auto bg-[hsl(0_0%_7%)] lg:hidden" data-theme="dark">
                    <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                        <Logo pathname={pathname} />
                        <button
                            aria-label="Close menu"
                            className="flex size-11 items-center justify-center text-white/80 transition-colors hover:bg-white/10"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            type="button"
                        >
                            <X className="size-5" />
                        </button>
                    </div>
                    <div className="flex flex-col px-5 py-4">
                        {menu.map((item) => (
                            <div className="border-b border-white/[0.06] py-3" key={item.navTitle}>
                                <p className="px-1 pb-2 font-mono text-xs tracking-wider text-white/40 uppercase">{item.navTitle}</p>
                                <div className="flex flex-col">
                                    {item.navItems
                                        .flatMap((navItem) => (isNavGroup(navItem) ? navItem.navItems : [navItem]))
                                        .map((leaf) =>
                                            leaf.href.startsWith("http") ? (
                                                <a
                                                    className="flex items-center justify-between py-2.5 text-base font-medium text-white/80"
                                                    href={leaf.href}
                                                    key={leaf.title}
                                                    rel="noreferrer"
                                                    target="_blank"
                                                >
                                                    {leaf.title}
                                                    <ChevronRight className="size-4 text-white/30" />
                                                </a>
                                            ) : (
                                                <Link
                                                    className="flex items-center justify-between py-2.5 text-base font-medium text-white/80"
                                                    key={leaf.title}
                                                    onClick={() => {
                                                        setIsMobileMenuOpen(false);
                                                    }}
                                                    to={leaf.href}
                                                >
                                                    {leaf.title}
                                                    <ChevronRight className="size-4 text-white/30" />
                                                </Link>
                                            ),
                                        )}
                                </div>
                            </div>
                        ))}
                        <div className="mt-6 flex flex-col gap-2">
                            <Button asChild className="h-11 gap-2 rounded-none border-white/15 bg-transparent text-sm font-medium text-white" variant="outline">
                                <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                                    Star on GitHub
                                </a>
                            </Button>
                            <Button asChild className="h-11 gap-1 rounded-none text-sm font-semibold" variant="default">
                                <Link
                                    onClick={() => {
                                        setIsMobileMenuOpen(false);
                                    }}
                                    to="/docs/$"
                                >
                                    Get started
                                    <ChevronRight className="size-4" />
                                </Link>
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </header>
    );
};

export default Navbar;
