"use client";

import DiscordLogoIcon from "@icons-pack/react-simple-icons/icons/SiDiscord.mjs";
import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link, useLocation } from "@tanstack/react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
    Bot,
    Boxes,
    ChevronRight,
    Clock,
    Cloud,
    Database,
    Handshake,
    HardDrive,
    HardDriveDownload,
    Home,
    KeyRound,
    LayoutDashboard,
    LayoutTemplate,
    Menu,
    Scale,
    ScrollText,
    Search,
    Server,
    Sparkles,
    X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import communityCard from "@/assets/images/community-card.webp";
import lunoraLogoRaw from "@/assets/lunora_logo.svg?raw";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import dashboardsImg from "@/assets/studio/dark/dashboards.png";
import homeImg from "@/assets/studio/dark/home.png";
import schemaImg from "@/assets/studio/dark/schema.png";
import { Button } from "@/components/ui/button";
import stats from "@/data/stats.json";
import { Shell } from "@/kit/layout";
import { cn } from "@/lib/utils";

/**
 * Primary navbar: a transparent bar — logo left, centered text links, a light
 * "GitHub" pill right — over a single dark dropdown that morphs size between
 * menus. Each dropdown pairs a vertical icon list with one or two tall feature
 * cards (Lunora Studio screenshots).
 */

const TRAILING_ZERO_DECIMAL = /\.0$/;

const formatStars = (count: number): string => {
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1).replace(TRAILING_ZERO_DECIMAL, "")}k`;
    }

    return count > 0 ? String(count) : "GitHub";
};

interface NavLeaf {
    description: string;
    href: string;
    icon: ReactNode;
    title: string;
}

interface NavFeature {
    href: string;
    image: string;
    subtitle: string;
    title: string;
}

interface NavColumn {
    featureLink?: { href: string; title: string };
    features: NavFeature[];
    /** Lay the nav items out in N columns (no feature cards). Default 1. */
    navColumns?: number;
    navItems: NavLeaf[];
    navTitle: string;
}

const menu: NavColumn[] = [
    {
        featureLink: { href: "/packages", title: "All packages" },
        features: [{ href: "/studio", image: schemaImg, subtitle: "Schema, data, SQL, and logs", title: "Studio" }],
        navItems: [
            { description: "Schema, queries, mutations, actions.", href: "/packages/server", icon: <Server />, title: "Server" },
            { description: "ShardDO + SessionDO: SQLite, OCC, WS.", href: "/packages/do", icon: <Database />, title: "Durable Objects" },
            { description: "Browser SDK, optimistic + offline queue.", href: "/packages/client", icon: <Boxes />, title: "Client" },
            { description: "useQuery, useMutation, useSubscription.", href: "/packages/react", icon: <Sparkles />, title: "React" },
            { description: "Live, indexed TanStack DB collections.", href: "/packages/db", icon: <HardDriveDownload />, title: "TanStack DB" },
        ],
        navTitle: "Packages",
    },
    {
        features: [
            {
                href: "/docs/getting-started",
                image: homeImg,
                subtitle: "A typed, live backend in an afternoon",
                title: "Getting started",
            },
        ],
        navItems: [
            { description: "Scaffold an app for your framework.", href: "/start", icon: <LayoutTemplate />, title: "Starter kits" },
            { description: "Auth: email/password, OAuth, passkeys.", href: "/packages/auth", icon: <KeyRound />, title: "Auth" },
            { description: "Workers AI on the Vercel AI SDK.", href: "/packages/ai", icon: <Bot />, title: "AI" },
            { description: "runAfter / runAt + Cron Triggers.", href: "/packages/scheduler", icon: <Clock />, title: "Scheduler" },
        ],
        navTitle: "Developers",
    },
    {
        features: [
            { href: "/studio", image: dashboardsImg, subtitle: "A local studio for your backend", title: "Lunora Studio" },
            {
                href: "https://discord.gg/eajEZvk2PG",
                image: communityCard,
                subtitle: "Join us on Discord",
                title: "Community",
            },
        ],
        navItems: [
            { description: "Thirteen runnable apps, five deploy in a click.", href: "/examples", icon: <Boxes />, title: "Examples" },
            { description: "Managed Lunora — join the waitlist.", href: "/cloud", icon: <Cloud />, title: "Lunora Cloud" },
            { description: "vs Convex, Supabase, Firebase, Appwrite.", href: "/compare", icon: <Scale />, title: "Compare" },
            { description: "Admin UI for schema, data, advisors.", href: "/studio", icon: <LayoutDashboard />, title: "Studio" },
            { description: "R2 typed buckets and signed URLs.", href: "/packages/storage", icon: <HardDrive />, title: "Storage" },
            { description: "New updates and improvements.", href: "/changelog", icon: <ScrollText />, title: "Changelog" },
            { description: "Q&A, ideas, and discussion.", href: "https://github.com/anolilab/lunora/discussions", icon: <Handshake />, title: "Discussions" },
            { description: "Chat with the community in real time.", href: "https://discord.gg/eajEZvk2PG", icon: <DiscordLogoIcon />, title: "Discord" },
            { description: "Issues, requests, and source code.", href: "https://github.com/anolilab/lunora", icon: <GitHubLogoIcon />, title: "GitHub" },
        ],
        navColumns: 3,
        navTitle: "Resources",
    },
];

const Logo = ({ onTint = true, pathname }: { onTint?: boolean; pathname: string }) => {
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            return undefined;
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

    const itemClass = "flex items-center gap-2 select-none p-3 text-sm leading-none text-ink-muted no-underline transition-colors hover:bg-wash hover:text-ink";

    return (
        <div className="relative">
            <div
                className="logo-context-menu"
                onContextMenu={(event: ReactMouseEvent) => {
                    event.preventDefault();
                    setIsOpen(true);
                }}
            >
                <Link className="group relative z-20 flex items-center gap-2.5" to={pathname.startsWith("/docs") ? "/docs" : "/"}>
                    <LunoraLogo className="h-7 w-7" title="Lunora" />
                    <span className={cn("text-body font-semibold tracking-tight", onTint ? "text-[hsl(240_14%_10%)]" : "text-ink")}>Lunora</span>
                </Link>
            </div>
            {isOpen && (
                <ul className="logo-context-menu absolute top-12 -left-2 z-10 block w-52 rounded-none border border-hairline bg-canvas p-2 text-ink shadow-xl">
                    <li>
                        <button
                            className={cn(itemClass, "w-full cursor-pointer rounded-none")}
                            onClick={() => void navigator.clipboard.writeText(lunoraLogoRaw)}
                            type="button"
                        >
                            <LunoraLogo className="h-4 w-4" title="Lunora" /> Copy Logo as SVG
                        </button>
                    </li>
                    <li className="py-1">
                        <hr className="border-hairline" />
                    </li>
                    <li>
                        <Link className={cn(itemClass, "rounded-none")} to="/">
                            <Home className="h-4 w-4" /> Home Page
                        </Link>
                    </li>
                </ul>
            )}
        </div>
    );
};

const LeafLink = ({ leaf, onNavigate }: { leaf: NavLeaf; onNavigate?: () => void }) => {
    const content = (
        <>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-none border border-hairline bg-wash text-ink-muted transition-colors group-hover/leaf:border-hairline-strong group-hover/leaf:text-ink [&>svg]:size-5">
                {leaf.icon}
            </span>
            <span className="flex flex-col gap-0.5">
                <span className="text-sm leading-none font-semibold text-ink">{leaf.title}</span>
                <span className="max-w-[200px] text-xs leading-snug text-ink-faint">{leaf.description}</span>
            </span>
        </>
    );
    const className = "group/leaf flex items-start gap-3 rounded-none px-3 py-2.5 no-underline transition-colors hover:bg-wash";

    return leaf.href.startsWith("http") ? (
        <a className={className} href={leaf.href} onClick={onNavigate} rel="noreferrer" target="_blank">
            {content}
        </a>
    ) : (
        <Link className={className} onClick={onNavigate} to={leaf.href}>
            {content}
        </Link>
    );
};

const FeatureCard = ({ feature, single }: { feature: NavFeature; single: boolean }) => {
    const content = (
        <>
            <img
                alt=""
                aria-hidden="true"
                className="absolute inset-0 size-full object-cover object-left-top transition-transform duration-500 group-hover/feat:scale-105"
                loading="lazy"
                src={feature.image}
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
            <div className="relative z-10 p-5">
                <p className="text-base font-semibold text-ink">{feature.title}</p>
                <p className="mt-0.5 text-sm text-ink-muted">{feature.subtitle}</p>
            </div>
        </>
    );
    const className = cn(
        "group/feat relative flex h-full min-h-[16rem] flex-col justify-end overflow-hidden rounded-none border border-hairline no-underline",
        single ? "w-[420px]" : "w-[244px]",
    );

    return feature.href.startsWith("http") ? (
        <a className={className} href={feature.href} rel="noreferrer" target="_blank">
            {content}
        </a>
    ) : (
        <Link className={className} to={feature.href}>
            {content}
        </Link>
    );
};

const MegaPanel = ({ column }: { column: NavColumn }) => {
    if (column.navColumns && column.navColumns > 1) {
        const rows = Math.ceil(column.navItems.length / column.navColumns);

        return (
            <div className="grid grid-flow-col gap-x-1" style={{ gridAutoColumns: "236px", gridTemplateRows: `repeat(${String(rows)}, auto)` }}>
                {column.navItems.map((leaf) => (
                    <LeafLink key={leaf.title} leaf={leaf} />
                ))}
            </div>
        );
    }

    return (
        <div className="flex gap-2">
            <ul className="flex w-[316px] flex-col">
                {column.navItems.map((leaf, index) => (
                    <li className={index > 0 ? "border-t border-hairline" : undefined} key={leaf.title}>
                        <LeafLink leaf={leaf} />
                    </li>
                ))}
            </ul>
            <div className="flex flex-col gap-2">
                <div className="flex flex-1 gap-2">
                    {column.features.map((feature) => (
                        <FeatureCard feature={feature} key={feature.title} single={column.features.length === 1} />
                    ))}
                </div>
                {column.featureLink ? (
                    <Link
                        className="group/all flex items-center justify-between rounded-none border border-hairline px-4 py-3 text-sm font-medium text-ink no-underline transition-colors hover:bg-wash"
                        to={column.featureLink.href}
                    >
                        {column.featureLink.title}
                        <ChevronRight className="size-4 text-ink-faint transition-transform group-hover/all:translate-x-0.5 group-hover/all:text-ink" />
                    </Link>
                ) : null}
            </div>
        </div>
    );
};

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="rounded-none bg-wash px-1.5 py-0.5 font-mono text-micro text-ink-muted">{children}</kbd>;

const SearchButton = () => {
    const { setOpenSearch } = useSearchContext();

    return (
        <button
            aria-label="Search"
            className={cn("flex size-9 items-center justify-center rounded-none transition-colors", "text-on-panel/80 hover:bg-on-panel/[0.05]")}
            onClick={() => {
                setOpenSearch(true);
            }}
            type="button"
        >
            <Search className="size-4" />
        </button>
    );
};

const Navbar = (): ReactElement => {
    const { pathname } = useLocation();
    const reduceMotion = useReducedMotion();
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const openWith = (title: string) => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
        }

        setOpenMenu(title);
    };

    const cancelClose = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
        }
    };

    const scheduleClose = () => {
        cancelClose();
        closeTimer.current = setTimeout(setOpenMenu, 160, null);
    };

    const active = menu.find((column) => column.navTitle === openMenu);

    return (
        <header className="fixed inset-x-0 top-0 z-100" data-theme="light" onMouseLeave={scheduleClose}>
            <Shell className="relative flex h-[var(--site-nav-height)] items-center">
                {/* The bar. Shell-width rather than full-bleed, so the page
                    shows past both ends, and the CTA is exactly its height so the
                    two read as one object rather than a button floating inside a
                    taller strip.

                    It runs the same 54s hue walk the platform strip used to —
                    that band gave the treatment up, because two gradients 60px
                    apart read as a mistake. Stops are set here rather than left
                    to the `@property` defaults, which is what keeps a re-brand
                    reaching them and what the bar paints when the animation is
                    off under `prefers-reduced-motion`. */}
                <div
                    aria-hidden="true"
                    className="animate-strip-hue pointer-events-none absolute inset-x-0 top-1/2 h-14 -translate-y-1/2 motion-reduce:animate-none"
                    style={
                        {
                            "--strip-a": "var(--site-accent-tint)",
                            "--strip-b": "var(--site-accent-2-tint)",
                            backgroundImage: "linear-gradient(100deg, var(--strip-a), var(--strip-b))",
                        } as CSSProperties
                    }
                />
                <div className="relative pl-4">
                    <Logo pathname={pathname} />
                </div>

                <nav aria-label="Primary navigation" className="absolute left-1/2 hidden -translate-x-1/2 items-center lg:flex">
                    <div
                        className="flex items-center"
                        onMouseEnter={() => {
                            setOpenMenu(null);
                        }}
                    >
                        <Link
                            className={cn(
                                "flex w-max items-center px-3.5 py-2 font-mono text-kicker uppercase transition-colors",
                                "text-on-panel/80 hover:text-on-panel/80",
                            )}
                            to="/docs"
                        >
                            Docs
                        </Link>
                    </div>
                    {menu.map((column) => (
                        <div
                            className="flex items-center"
                            key={column.navTitle}
                            onMouseEnter={() => {
                                openWith(column.navTitle);
                            }}
                        >
                            <button
                                aria-expanded={openMenu === column.navTitle}
                                className={cn(
                                    "flex w-max cursor-default items-center px-3.5 py-2 font-mono text-kicker uppercase transition-colors",
                                    "text-on-panel/80 hover:text-on-panel/80",
                                )}
                                onFocus={() => {
                                    openWith(column.navTitle);
                                }}
                                type="button"
                            >
                                {column.navTitle}
                            </button>
                        </div>
                    ))}
                    <div
                        className="flex items-center"
                        onMouseEnter={() => {
                            setOpenMenu(null);
                        }}
                    >
                        <Link
                            className={cn(
                                "flex w-max items-center px-3.5 py-2 font-mono text-kicker uppercase transition-colors",
                                "text-on-panel/80 hover:text-on-panel/80",
                            )}
                            to="/blog"
                        >
                            Blog
                        </Link>
                    </div>
                </nav>

                <div className="relative ml-auto hidden items-center gap-2 lg:flex">
                    <SearchButton />
                    <a
                        aria-label="Join the Lunora Discord"
                        className={cn("flex size-9 items-center justify-center rounded-none transition-colors", "text-on-panel/80 hover:bg-on-panel/[0.05]")}
                        href="https://discord.gg/eajEZvk2PG"
                        rel="noreferrer"
                        target="_blank"
                    >
                        <DiscordLogoIcon className="size-4 fill-current" title="Lunora on Discord" />
                    </a>
                    <a
                        aria-label={`GitHub repository (${formatStars(stats.stars)} stars)`}
                        className={cn(
                            "flex h-10 items-center gap-2 rounded-none px-3 font-mono text-kicker uppercase transition-colors",
                            "text-on-panel/85 hover:text-on-panel",
                        )}
                        href="https://github.com/anolilab/lunora"
                        rel="noreferrer"
                        target="_blank"
                    >
                        <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                        <span className="font-mono tabular-nums">{formatStars(stats.stars)}</span>
                    </a>
                    <Button
                        asChild
                        className={cn("h-14 gap-2 rounded-none px-6 font-mono text-kicker uppercase", "bg-on-panel text-panel hover:opacity-90")}
                        variant="ghost"
                    >
                        <Link to="/docs">
                            Get started
                            <ChevronRight className="size-4" />
                        </Link>
                    </Button>
                </div>

                <button
                    aria-label="Open menu"
                    className={cn(
                        "relative ml-auto flex size-9 items-center justify-center rounded-none lg:hidden",
                        "text-on-panel/85 hover:bg-on-panel/[0.05]",
                    )}
                    onClick={() => {
                        setIsMobileMenuOpen(true);
                    }}
                    type="button"
                >
                    <Menu className="size-5" />
                </button>
            </Shell>

            {/* mega-menu dropdown — a single centered box that morphs size between
                menus. It docks at `--site-nav-height` — the same token the page
                header's clearance and every sticky filter bar use, so the open
                panel and those bars share one top line rather than missing it by
                a couple of pixels. The tinted bar is `h-14` centred in the row,
                so it ends inside that offset and nothing is covered. */}
            <div
                className="absolute top-[var(--site-nav-height)] left-1/2 hidden -translate-x-1/2 lg:block"
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
            >
                <AnimatePresence>
                    {active ? (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            initial={{ opacity: 0, y: -8 }}
                            key="mega"
                            transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <motion.div
                                className="overflow-hidden rounded-none border border-hairline bg-canvas p-2 shadow-2xl shadow-black/70"
                                layout
                                transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <MegaPanel column={active} />
                            </motion.div>
                            <div className="pointer-events-none mt-3 flex items-center justify-center gap-5 text-xs text-ink-faint">
                                <span className="flex items-center gap-1.5">
                                    <Kbd>↓</Kbd> Enter menu
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <Kbd>tab</Kbd> Navigate menu
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <Kbd>↑</Kbd> Exit menu
                                </span>
                            </div>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>

            {/* mobile menu */}
            {isMobileMenuOpen && (
                <div className="fixed inset-0 z-[110] overflow-y-auto bg-canvas lg:hidden" data-theme="dark">
                    <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                        <Logo onTint={false} pathname={pathname} />
                        <button
                            aria-label="Close menu"
                            className="flex size-10 items-center justify-center rounded-none text-ink-muted transition-colors hover:bg-wash"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            type="button"
                        >
                            <X className="size-5" />
                        </button>
                    </div>
                    <div className="flex flex-col px-5 py-4">
                        <Link
                            className="border-b border-hairline px-1 py-3 text-sm font-medium text-ink"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            to="/docs"
                        >
                            Docs
                        </Link>
                        <Link
                            className="border-b border-hairline px-1 py-3 text-sm font-medium text-ink"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            to="/blog"
                        >
                            Blog
                        </Link>
                        {menu.map((column) => (
                            <div className="border-b border-hairline py-3" key={column.navTitle}>
                                <p className="px-1 pb-2 font-mono text-xs tracking-wider text-ink-faint uppercase">{column.navTitle}</p>
                                <div className="flex flex-col gap-0.5">
                                    {column.navItems.map((leaf) => (
                                        <LeafLink
                                            key={leaf.title}
                                            leaf={leaf}
                                            onNavigate={() => {
                                                setIsMobileMenuOpen(false);
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                        <div className="mt-6 flex flex-col gap-2">
                            <Button
                                asChild
                                className="h-11 gap-2 rounded-none border-hairline-strong bg-transparent text-sm font-medium text-ink"
                                variant="outline"
                            >
                                <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                                    Star on GitHub
                                </a>
                            </Button>
                            <Button
                                asChild
                                className="h-11 gap-2 rounded-none border-hairline-strong bg-transparent text-sm font-medium text-ink"
                                variant="outline"
                            >
                                <a href="https://discord.gg/eajEZvk2PG" rel="noreferrer" target="_blank">
                                    <DiscordLogoIcon className="size-4 fill-current" title="Lunora on Discord" />
                                    Join Discord
                                </a>
                            </Button>
                            <Button asChild className="h-11 gap-1 rounded-none text-sm font-semibold" variant="default">
                                <Link
                                    onClick={() => {
                                        setIsMobileMenuOpen(false);
                                    }}
                                    to="/docs"
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
