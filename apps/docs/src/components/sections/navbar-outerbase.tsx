"use client";

import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link, useLocation } from "@tanstack/react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
    ArrowUpRight,
    Book,
    Bot,
    Boxes,
    ChevronDown,
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
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import lunoraLogoRaw from "@/assets/lunora_logo.svg?raw";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import { Button } from "@/components/ui/button";
import stats from "@/data/stats.json";
import { cn } from "@/lib/utils";

/**
 * Outerbase-style navbar (experiment): a floating, centered glass bar with
 * mega-menu dropdowns that carry a featured preview image (sourced from
 * Unsplash). Adapts dark/light to the section under it. Swapped into __root.
 */

const unsplash = (id: string): string => `https://images.unsplash.com/${id}?q=80&w=640&auto=format&fit=crop`;

const formatStars = (count: number): string => {
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    }

    return count > 0 ? String(count) : "Star";
};

interface NavLeaf {
    description: string;
    href: string;
    icon: ReactNode;
    title: string;
}

interface NavColumn {
    featured: { credit: string; href: string; image: string; subtitle: string; title: string };
    navTitle: string;
    navItems: NavLeaf[];
}

const menu: NavColumn[] = [
    {
        featured: {
            credit: "Unsplash",
            href: "/packages",
            image: unsplash("photo-1654198340681-a2e0fc449f1b"),
            subtitle: "Server, client, framework adapters, and add-ons — one typed surface.",
            title: "Explore all packages",
        },
        navItems: [
            { description: "Schema, queries, mutations, actions.", href: "/packages/server", icon: <Server className="size-4.5" />, title: "Server" },
            { description: "ShardDO + SessionDO: SQLite, OCC, WS.", href: "/packages/do", icon: <Database className="size-4.5" />, title: "Durable Objects" },
            { description: "Browser SDK, optimistic + offline queue.", href: "/packages/client", icon: <Boxes className="size-4.5" />, title: "Client" },
            { description: "useQuery, useMutation, useSubscription.", href: "/packages/react", icon: <Sparkles className="size-4.5" />, title: "React" },
            { description: "Codegen, type sync, dev server.", href: "/packages/vite", icon: <Wrench className="size-4.5" />, title: "Vite Plugin" },
            {
                description: "Live, indexed TanStack DB collections.",
                href: "/packages/db",
                icon: <HardDriveDownload className="size-4.5" />,
                title: "TanStack DB",
            },
        ],
        navTitle: "Packages",
    },
    {
        featured: {
            credit: "Unsplash",
            href: "/docs/getting-started",
            image: unsplash("photo-1635776062360-af423602aff3"),
            subtitle: "Go from a fresh project to a typed, live backend in an afternoon.",
            title: "Getting started",
        },
        navItems: [
            { description: "Build your first app in minutes.", href: "/docs/getting-started", icon: <Rocket className="size-4.5" />, title: "Quickstart" },
            { description: "The full Lunora framework reference.", href: "/docs/", icon: <Book className="size-4.5" />, title: "Documentation" },
            { description: "Auth: email/password, OAuth, passkeys.", href: "/packages/auth", icon: <KeyRound className="size-4.5" />, title: "Auth" },
            { description: "Workers AI on the Vercel AI SDK.", href: "/packages/ai", icon: <Bot className="size-4.5" />, title: "AI" },
            { description: "runAfter / runAt + Cron Triggers.", href: "/packages/scheduler", icon: <Clock className="size-4.5" />, title: "Scheduler" },
            { description: "New updates and improvements.", href: "/changelog", icon: <ScrollText className="size-4.5" />, title: "Changelog" },
        ],
        navTitle: "Developers",
    },
    {
        featured: {
            credit: "Unsplash",
            href: "/packages/studio",
            image: unsplash("photo-1566410824233-a8011929225c"),
            subtitle: "A local studio for schema, data, SQL, logs, and time-travel.",
            title: "Lunora Studio",
        },
        navItems: [
            { description: "Admin UI for schema, data, advisors.", href: "/packages/studio", icon: <LayoutDashboard className="size-4.5" />, title: "Studio" },
            { description: "R2 typed buckets and signed URLs.", href: "/packages/storage", icon: <HardDrive className="size-4.5" />, title: "Storage" },
            {
                description: "Q&A, ideas, and discussion.",
                href: "https://github.com/anolilab/lunora/discussions",
                icon: <Handshake className="size-4.5" />,
                title: "Discussions",
            },
            {
                description: "Issues, requests, and source code.",
                href: "https://github.com/anolilab/lunora",
                icon: <GitHubLogoIcon className="size-4.5" />,
                title: "GitHub",
            },
        ],
        navTitle: "Resources",
    },
];

const Logo = ({ light, pathname }: { light: boolean; pathname: string }) => {
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

        return () => document.removeEventListener("click", handleOutsideClick);
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
                <ul className="logo-context-menu absolute top-12 -left-2 z-10 block w-52 rounded-xl border border-white/10 bg-[hsl(240_18%_8%)] p-2 text-white shadow-xl">
                    <li>
                        <button
                            className={cn(itemClass, "w-full cursor-pointer rounded-lg")}
                            onClick={() => navigator.clipboard.writeText(lunoraLogoRaw)}
                            type="button"
                        >
                            <LunoraLogo className="h-4 w-4" title="Lunora" /> Copy Logo as SVG
                        </button>
                    </li>
                    <li className="py-1">
                        <hr className="border-white/10" />
                    </li>
                    <li>
                        <Link className={cn(itemClass, "rounded-lg")} target="_blank" to="/brand">
                            <Signature className="h-4 w-4" /> Brand Guidelines
                        </Link>
                    </li>
                    <li>
                        <Link className={cn(itemClass, "rounded-lg")} to="/">
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
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-white/70 transition-colors group-hover/leaf:border-white/20 group-hover/leaf:text-white">
                {leaf.icon}
            </span>
            <span className="flex flex-col gap-0.5">
                <span className="text-sm leading-none font-medium text-white">{leaf.title}</span>
                <span className="line-clamp-1 text-xs leading-snug text-white/45">{leaf.description}</span>
            </span>
        </>
    );
    const className = "group/leaf flex items-start gap-3 rounded-xl p-2.5 no-underline transition-colors hover:bg-white/[0.05]";

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

const MegaPanel = ({ column }: { column: NavColumn }) => (
    <div className="grid w-[680px] grid-cols-[260px_1fr] gap-2 p-2">
        <Link className="group/feat relative flex flex-col justify-end overflow-hidden rounded-xl border border-white/10 p-4" to={column.featured.href}>
            <img
                alt=""
                aria-hidden="true"
                className="absolute inset-0 size-full object-cover opacity-60 transition-all duration-500 group-hover/feat:scale-105 group-hover/feat:opacity-75"
                loading="lazy"
                src={column.featured.image}
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[hsl(240_20%_4%)] via-[hsl(240_20%_4%)]/55 to-transparent" />
            <div className="relative z-10 flex flex-col gap-1.5">
                <span className="flex items-center gap-1 text-sm font-semibold text-white">
                    {column.featured.title}
                    <ArrowUpRight className="size-3.5 transition-transform duration-300 group-hover/feat:translate-x-0.5 group-hover/feat:-translate-y-0.5" />
                </span>
                <span className="text-xs leading-snug text-white/70">{column.featured.subtitle}</span>
                <span className="mt-1 font-mono text-[10px] tracking-wider text-white/35 uppercase">Photo · {column.featured.credit}</span>
            </div>
        </Link>
        <ul className="grid grid-cols-2 gap-0.5">
            {column.navItems.map((leaf) => (
                <li key={leaf.title}>
                    <LeafLink leaf={leaf} />
                </li>
            ))}
        </ul>
    </div>
);

const SearchButton = ({ light }: { light: boolean }) => {
    const { setOpenSearch } = useSearchContext();

    return (
        <button
            aria-label="Search"
            className={cn(
                "flex size-9 items-center justify-center rounded-full border transition-colors",
                light ? "border-black/10 text-black/60 hover:bg-black/[0.05]" : "border-white/10 text-white/70 hover:bg-white/[0.06] hover:text-white",
            )}
            onClick={() => setOpenSearch(true)}
            type="button"
        >
            <Search className="size-4" />
        </button>
    );
};

const Navbar = () => {
    const { pathname } = useLocation();
    const reduceMotion = useReducedMotion();
    const [light, setLight] = useState(false);
    const [scrolled, setScrolled] = useState(false);
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
                setScrolled(window.scrollY > 10);
                ticking = false;
            });
        };

        window.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();

        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    const openWith = (title: string) => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
        }

        setOpenMenu(title);
    };

    const scheduleClose = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
        }

        closeTimer.current = setTimeout(() => setOpenMenu(null), 120);
    };

    const active = menu.find((column) => column.navTitle === openMenu);

    return (
        <header className="fixed inset-x-0 top-0 z-100 px-4 pt-3" data-theme={light ? "light" : "dark"}>
            <div
                className={cn(
                    "mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 rounded-2xl border px-3 pl-4 backdrop-blur-xl transition-colors duration-300",
                    light
                        ? "border-black/[0.08] bg-white/70 shadow-lg shadow-black/[0.04]"
                        : cn("border-white/10 shadow-xl shadow-black/30", scrolled || openMenu ? "bg-[hsl(240_18%_7%)]/85" : "bg-[hsl(240_18%_7%)]/55"),
                )}
                onMouseLeave={scheduleClose}
            >
                <Logo light={light} pathname={pathname} />

                <nav aria-label="Primary navigation" className="hidden h-full items-center lg:flex">
                    {menu.map((column) => (
                        <div className="flex h-full items-center" key={column.navTitle} onMouseEnter={() => openWith(column.navTitle)}>
                            <button
                                aria-expanded={openMenu === column.navTitle}
                                className={cn(
                                    "flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
                                    light
                                        ? "text-black/70 hover:text-black data-[open=true]:text-black"
                                        : "text-white/70 hover:text-white data-[open=true]:text-white",
                                )}
                                data-open={openMenu === column.navTitle}
                                onFocus={() => openWith(column.navTitle)}
                                type="button"
                            >
                                {column.navTitle}
                                <ChevronDown className={cn("size-3.5 transition-transform duration-300", openMenu === column.navTitle && "rotate-180")} />
                            </button>
                        </div>
                    ))}
                </nav>

                <div className="hidden items-center gap-1.5 lg:flex">
                    <SearchButton light={light} />
                    <a
                        aria-label={`GitHub repository (${formatStars(stats.stars)} stars)`}
                        className={cn(
                            "flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors",
                            light
                                ? "border-black/10 text-black/70 hover:bg-black/[0.05]"
                                : "border-white/12 text-white/80 hover:bg-white/[0.06] hover:text-white",
                        )}
                        href="https://github.com/anolilab/lunora"
                        rel="noreferrer"
                        target="_blank"
                    >
                        <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                        <span className="font-mono tabular-nums">{formatStars(stats.stars)}</span>
                    </a>
                    <Button asChild className="h-9 gap-1 rounded-full px-4 text-sm font-semibold" variant="default">
                        <Link to="/docs/$">
                            Get started
                            <ChevronRight className="size-4" />
                        </Link>
                    </Button>
                </div>

                <button
                    aria-label="Open menu"
                    className={cn(
                        "flex size-9 items-center justify-center rounded-full lg:hidden",
                        light ? "text-black/70 hover:bg-black/[0.05]" : "text-white/80 hover:bg-white/10",
                    )}
                    onClick={() => setIsMobileMenuOpen(true)}
                    type="button"
                >
                    <Menu className="size-5" />
                </button>

                {/* mega-menu dropdown */}
                <AnimatePresence>
                    {active ? (
                        <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            className="absolute top-[calc(100%+8px)] left-1/2 z-50 hidden -translate-x-1/2 lg:block"
                            exit={{ opacity: 0, y: -6 }}
                            initial={{ opacity: 0, y: -6 }}
                            key={active.navTitle}
                            onMouseEnter={() => openWith(active.navTitle)}
                            onMouseLeave={scheduleClose}
                            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <div className="overflow-hidden rounded-2xl border border-white/10 bg-[hsl(240_18%_7%)]/90 shadow-2xl shadow-black/50 backdrop-blur-2xl">
                                <MegaPanel column={active} />
                            </div>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>

            {/* mobile menu */}
            {isMobileMenuOpen && (
                <div className="fixed inset-0 z-[110] overflow-y-auto bg-[hsl(240_18%_5%)] lg:hidden" data-theme="dark">
                    <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                        <Logo light={false} pathname={pathname} />
                        <button
                            aria-label="Close menu"
                            className="flex size-10 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10"
                            onClick={() => setIsMobileMenuOpen(false)}
                            type="button"
                        >
                            <X className="size-5" />
                        </button>
                    </div>
                    <div className="flex flex-col px-5 py-4">
                        {menu.map((column) => (
                            <div className="border-b border-white/[0.06] py-3" key={column.navTitle}>
                                <p className="px-1 pb-2 font-mono text-xs tracking-wider text-white/40 uppercase">{column.navTitle}</p>
                                <div className="flex flex-col gap-0.5">
                                    {column.navItems.map((leaf) => (
                                        <LeafLink key={leaf.title} leaf={leaf} onNavigate={() => setIsMobileMenuOpen(false)} />
                                    ))}
                                </div>
                            </div>
                        ))}
                        <div className="mt-6 flex flex-col gap-2">
                            <Button asChild className="h-11 gap-2 rounded-full border-white/15 bg-transparent text-sm font-medium text-white" variant="outline">
                                <a href="https://github.com/anolilab/lunora" rel="noreferrer" target="_blank">
                                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                                    Star on GitHub
                                </a>
                            </Button>
                            <Button asChild className="h-11 gap-1 rounded-full text-sm font-semibold" variant="default">
                                <Link onClick={() => setIsMobileMenuOpen(false)} to="/docs/$">
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
