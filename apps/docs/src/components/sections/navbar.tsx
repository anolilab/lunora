"use client";

import DiscordLogoIcon from "@icons-pack/react-simple-icons/icons/SiDiscord.mjs";
import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link, useLocation } from "@tanstack/react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
    Book,
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
    Rocket,
    Scale,
    ScrollText,
    Search,
    Server,
    Sparkles,
    X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import lunoraLogoRaw from "@/assets/lunora_logo.svg?raw";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import dashboardsImg from "@/assets/studio/dark/dashboards.png";
import homeImg from "@/assets/studio/dark/home.png";
import schemaImg from "@/assets/studio/dark/schema.png";
import { Button } from "@/components/ui/button";
import stats from "@/data/stats.json";
import { cn } from "@/lib/utils";

/**
 * Primary navbar: a transparent bar — logo left, centered text links, a light
 * "GitHub" pill right — over a single dark dropdown that morphs size between
 * menus. Each dropdown pairs a vertical icon list with one or two tall feature
 * cards (Lunora Studio screenshots).
 */

const card = (id: string): string => `https://images.unsplash.com/${id}?q=80&w=900&auto=format&fit=crop`;

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
            { description: "Build your first app in minutes.", href: "/docs/getting-started", icon: <Rocket />, title: "Quickstart" },
            { description: "Scaffold an app for your framework.", href: "/start", icon: <LayoutTemplate />, title: "Starter kits" },
            { description: "The full Lunora framework reference.", href: "/docs/", icon: <Book />, title: "Documentation" },
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
                image: card("photo-1614852206732-6728910dc175"),
                subtitle: "Join us on Discord",
                title: "Community",
            },
        ],
        navItems: [
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

const Logo = ({ light, pathname }: { light: boolean; pathname: string }) => {
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

    const itemClass =
        "flex items-center gap-2 select-none p-3 text-sm leading-none text-white/80 no-underline transition-colors hover:bg-white/10 hover:text-white";

    return (
        <div className="relative">
            <div
                className="logo-context-menu"
                onContextMenu={(event: ReactMouseEvent) => {
                    event.preventDefault();
                    setIsOpen(true);
                }}
            >
                <Link className="group relative z-20 flex items-center gap-2.5" to={pathname.startsWith("/docs") ? "/docs/$" : "/"}>
                    <LunoraLogo className="h-7 w-7" title="Lunora" />
                    <span className={cn("text-[15px] font-semibold tracking-tight", light ? "text-[hsl(240_14%_10%)]" : "text-white")}>Lunora</span>
                </Link>
            </div>
            {isOpen && (
                <ul className="logo-context-menu absolute top-12 -left-2 z-10 block w-52 rounded-none border border-white/[0.08] bg-[#0e0e11] p-2 text-white shadow-xl">
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
                        <hr className="border-white/10" />
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
            <span className="flex size-10 shrink-0 items-center justify-center rounded-none border border-white/10 bg-white/[0.04] text-white/80 transition-colors group-hover/leaf:border-white/20 group-hover/leaf:text-white [&>svg]:size-5">
                {leaf.icon}
            </span>
            <span className="flex flex-col gap-0.5">
                <span className="text-sm leading-none font-semibold text-white">{leaf.title}</span>
                <span className="max-w-[200px] text-xs leading-snug text-white/45">{leaf.description}</span>
            </span>
        </>
    );
    const className = "group/leaf flex items-start gap-3 rounded-none px-3 py-2.5 no-underline transition-colors hover:bg-white/[0.05]";

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
                <p className="text-base font-semibold text-white">{feature.title}</p>
                <p className="mt-0.5 text-sm text-white/70">{feature.subtitle}</p>
            </div>
        </>
    );
    const className = cn(
        "group/feat relative flex h-full min-h-[16rem] flex-col justify-end overflow-hidden rounded-none border border-white/[0.08] no-underline",
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
                    <li className={index > 0 ? "border-t border-white/[0.08]" : undefined} key={leaf.title}>
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
                        className="group/all flex items-center justify-between rounded-none border border-white/[0.08] px-4 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-white/[0.05]"
                        to={column.featureLink.href}
                    >
                        {column.featureLink.title}
                        <ChevronRight className="size-4 text-white/40 transition-transform group-hover/all:translate-x-0.5 group-hover/all:text-white" />
                    </Link>
                ) : null}
            </div>
        </div>
    );
};

const Kbd = ({ children }: { children: ReactNode }) => (
    <kbd className="rounded-none bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/70">{children}</kbd>
);

const SearchButton = ({ light }: { light: boolean }) => {
    const { setOpenSearch } = useSearchContext();

    return (
        <button
            aria-label="Search"
            className={cn(
                "flex size-9 items-center justify-center rounded-none transition-colors",
                light ? "text-black/60 hover:bg-black/[0.05]" : "text-white/70 hover:bg-white/[0.08] hover:text-white",
            )}
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
    const [light, setLight] = useState(false);
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let ticking = false;

        const handleScroll = () => {
            if (ticking) {
                return;
            }

            ticking = true;

            requestAnimationFrame(() => {
                const sections = document.querySelectorAll("section[data-nav-theme]");
                let theme = "dark";

                for (const section of sections) {
                    const rect = section.getBoundingClientRect();

                    if (rect.top <= 8 && rect.bottom > 8) {
                        theme = (section as HTMLElement).dataset.navTheme ?? "dark";
                    }
                }

                setLight(theme === "light");
                ticking = false;
            });
        };

        window.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();

        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, []);

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
    const onDocs = pathname.startsWith("/docs");

    return (
        <header
            className={cn("fixed inset-x-0 top-0 z-100", onDocs && "border-b border-white/[0.08] bg-[#0e0e11]")}
            data-theme={light ? "light" : "dark"}
            onMouseLeave={scheduleClose}
        >
            <div className="relative mx-auto flex h-16 max-w-6xl items-center px-5">
                <Logo light={light} pathname={pathname} />

                <nav aria-label="Primary navigation" className="absolute left-1/2 hidden -translate-x-1/2 items-center lg:flex">
                    <div
                        className="flex items-center"
                        onMouseEnter={() => {
                            setOpenMenu(null);
                        }}
                    >
                        <Link
                            className={cn(
                                "flex w-max items-center px-3.5 py-2 text-sm font-medium transition-colors",
                                light ? "text-black/80 hover:text-black/60" : "text-white hover:text-neutral-300",
                            )}
                            to="/docs/$"
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
                                    "flex w-max cursor-default items-center px-3.5 py-2 text-sm font-medium transition-colors",
                                    light ? "text-black/80 hover:text-black/60" : "text-white hover:text-neutral-300",
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
                                "flex w-max items-center px-3.5 py-2 text-sm font-medium transition-colors",
                                light ? "text-black/80 hover:text-black/60" : "text-white hover:text-neutral-300",
                            )}
                            to="/blog"
                        >
                            Blog
                        </Link>
                    </div>
                </nav>

                <div className="ml-auto hidden items-center gap-2 lg:flex">
                    <SearchButton light={light} />
                    <a
                        aria-label="Join the Lunora Discord"
                        className={cn(
                            "flex size-9 items-center justify-center rounded-none transition-colors",
                            light ? "text-black/60 hover:bg-black/[0.05]" : "text-white/70 hover:bg-white/[0.08] hover:text-white",
                        )}
                        href="https://discord.gg/eajEZvk2PG"
                        rel="noreferrer"
                        target="_blank"
                    >
                        <DiscordLogoIcon className="size-4 fill-current" title="Lunora on Discord" />
                    </a>
                    <a
                        aria-label={`GitHub repository (${formatStars(stats.stars)} stars)`}
                        className={cn(
                            "flex h-9 items-center gap-1.5 rounded-none px-4 text-sm font-medium transition-colors",
                            light ? "bg-neutral-900 text-white hover:bg-neutral-800" : "bg-white text-neutral-900 hover:bg-white/90",
                        )}
                        href="https://github.com/anolilab/lunora"
                        rel="noreferrer"
                        target="_blank"
                    >
                        <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                        <span className="font-mono tabular-nums">{formatStars(stats.stars)}</span>
                    </a>
                    <Button asChild className="h-9 gap-1 rounded-none px-4 text-sm font-semibold" variant="default">
                        <Link to="/docs/$">
                            Get started
                            <ChevronRight className="size-4" />
                        </Link>
                    </Button>
                </div>

                <button
                    aria-label="Open menu"
                    className={cn(
                        "ml-auto flex size-9 items-center justify-center rounded-none lg:hidden",
                        light ? "text-black/70 hover:bg-black/[0.05]" : "text-white/80 hover:bg-white/10",
                    )}
                    onClick={() => {
                        setIsMobileMenuOpen(true);
                    }}
                    type="button"
                >
                    <Menu className="size-5" />
                </button>
            </div>

            {/* mega-menu dropdown — a single centered box that morphs size between menus */}
            <div className="absolute top-[4.25rem] left-1/2 hidden -translate-x-1/2 lg:block" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
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
                                className="overflow-hidden rounded-none border border-white/[0.08] bg-[#0e0e11] p-2 shadow-2xl shadow-black/70"
                                layout
                                transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <MegaPanel column={active} />
                            </motion.div>
                            <div className="pointer-events-none mt-3 flex items-center justify-center gap-5 text-xs text-white/45">
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
                <div className="fixed inset-0 z-[110] overflow-y-auto bg-[#0e0e11] lg:hidden" data-theme="dark">
                    <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
                        <Logo light={false} pathname={pathname} />
                        <button
                            aria-label="Close menu"
                            className="flex size-10 items-center justify-center rounded-none text-white/80 transition-colors hover:bg-white/10"
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
                            className="border-b border-white/[0.06] px-1 py-3 text-sm font-medium text-white"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            to="/docs/$"
                        >
                            Docs
                        </Link>
                        <Link
                            className="border-b border-white/[0.06] px-1 py-3 text-sm font-medium text-white"
                            onClick={() => {
                                setIsMobileMenuOpen(false);
                            }}
                            to="/blog"
                        >
                            Blog
                        </Link>
                        {menu.map((column) => (
                            <div className="border-b border-white/[0.06] py-3" key={column.navTitle}>
                                <p className="px-1 pb-2 font-mono text-xs tracking-wider text-white/40 uppercase">{column.navTitle}</p>
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
                            <Button asChild className="h-11 gap-2 rounded-none border-white/15 bg-transparent text-sm font-medium text-white" variant="outline">
                                <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                                    Star on GitHub
                                </a>
                            </Button>
                            <Button asChild className="h-11 gap-2 rounded-none border-white/15 bg-transparent text-sm font-medium text-white" variant="outline">
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
