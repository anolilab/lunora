import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight, Download, Package, Search } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";
import HighlightLink from "@/components/ui/highlight-link";
import type { AccentColor, Category, PackageInfo } from "@/data/packages";
import { categories, packages } from "@/data/packages";
import { cn, formatNumber } from "@/lib/utils";
import type { DownloadStats } from "@/server/stats";
import { getStats } from "@/server/stats";

const accentStyles: Record<AccentColor, { badge: string; badgeLight: string; border: string; hover: string; link: string }> = {
    "crimson-energy": {
        badge: "bg-crimson-energy/20 text-crimson-energy",
        badgeLight: "bg-crimson-energy/10 text-crimson-energy",
        border: "group-hover:border-crimson-energy/30",
        hover: "group-hover:via-crimson-energy/[0.04]",
        link: "text-crimson-energy",
    },
    "royal-amethyst": {
        badge: "bg-royal-amethyst/20 text-royal-amethyst",
        badgeLight: "bg-royal-amethyst/10 text-royal-amethyst",
        border: "group-hover:border-royal-amethyst/30",
        hover: "group-hover:via-royal-amethyst/[0.04]",
        link: "text-royal-amethyst",
    },
    "sky-sapphire": {
        badge: "bg-sky-sapphire/20 text-sky-sapphire",
        badgeLight: "bg-sky-sapphire/10 text-sky-sapphire",
        border: "group-hover:border-sky-sapphire/30",
        hover: "group-hover:via-sky-sapphire/[0.04]",
        link: "text-sky-sapphire",
    },
};

const PackageCard: FC<{ pkg: PackageInfo; weeklyDownloads: number }> = ({ pkg, weeklyDownloads }) => {
    const styles = accentStyles[pkg.accentColor];

    return (
        <Link
            className={cn(
                "group relative flex h-full flex-col gap-4 border-y border-white/6 bg-gradient-to-br from-transparent via-transparent to-transparent p-6 transition-all duration-300",
                styles.border,
                styles.hover,
            )}
            params={{ slug: pkg.slug }}
            to="/packages/$slug"
        >
            <div className="flex items-center justify-between">
                <span className={cn("inline-block px-2.5 py-0.5 font-mono text-[11px] font-medium", styles.badge)}>{pkg.category}</span>
                {weeklyDownloads > 0 && (
                    <span className="flex items-center gap-1.5 font-mono text-xs text-white/30">
                        <Download className="h-3 w-3" />
                        {formatNumber(weeklyDownloads)}
                        /wk
                    </span>
                )}
            </div>
            <h3 className="text-lg font-semibold tracking-tight text-white transition-colors group-hover:text-white">{pkg.name}</h3>
            <p className="line-clamp-2 text-sm leading-relaxed text-white/40 transition-colors group-hover:text-white/60">{pkg.description}</p>
            <div className="mt-auto flex items-center gap-2 pt-2">
                <span className={cn("text-sm font-medium transition-colors", styles.link)}>Learn more</span>
                <ArrowRight className={cn("h-3.5 w-3.5 transition-transform group-hover:translate-x-1", styles.link)} />
            </div>
        </Link>
    );
};

const CategoryFilter: FC<{
    active: Category;
    mode: "dark" | "light";
    onChange: (category: Category) => void;
}> = ({ active, mode, onChange }) => (
    <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
            <button
                className={cn(
                    "border px-4 py-1.5 font-mono text-xs font-medium transition-all duration-200",
                    mode === "light"
                        ? active === cat
                            ? "border-gray-900 bg-gray-900 text-white"
                            : "border-gray-200 text-gray-400 hover:border-gray-400 hover:text-gray-600"
                        : active === cat
                          ? "border-white/20 bg-white/10 text-white"
                          : "border-white/6 text-white/40 hover:border-white/10 hover:text-white/60",
                )}
                key={cat}
                onClick={() => {
                    onChange(cat);
                }}
                type="button"
            >
                {cat}
            </button>
        ))}
    </div>
);

const StatBlock: FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="flex flex-col gap-1">
        <span className="text-3xl font-bold tracking-tight text-gray-900 lg:text-4xl">{value}</span>
        <span className="font-mono text-xs tracking-wider text-gray-400 uppercase">{label}</span>
    </div>
);

const PackagesListing: FC = () => {
    const [activeCategory, setActiveCategory] = useState<Category>("All");
    const [search, setSearch] = useState("");
    const [stats, setStats] = useState<DownloadStats | null>(null);

    const fetchStats = useCallback(async () => {
        try {
            const data = await getStats();

            setStats(data);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const totalWeeklyDownloads = useMemo(() => {
        if (!stats?.weeklyDownloads) {
            return 0;
        }

        return Object.values(stats.weeklyDownloads).reduce((sum, v) => sum + v, 0);
    }, [stats]);

    const categoryCount = categories.length - 1; // minus "All"

    const filteredPackages = useMemo(() => {
        let result: PackageInfo[] = packages;

        if (activeCategory !== "All") {
            result = result.filter((p) => p.category === activeCategory);
        }

        if (search.trim()) {
            const query = search.toLowerCase();

            result = result.filter(
                (p) =>
                    p.name.toLowerCase().includes(query) ||
                    p.description.toLowerCase().includes(query) ||
                    p.npmName.toLowerCase().includes(query) ||
                    p.category.toLowerCase().includes(query),
            );
        }

        return result;
    }, [activeCategory, search]);

    return (
        <>
            <Section classes={{ childrenWrapper: "gap-y-0", root: "pt-36 pb-0" }} mode="light" patternColor="sky-sapphire" patternPosition="bottom">
                <div className="col-span-3">
                    <span className="flex items-center gap-2 font-mono text-sm tracking-wider text-gray-400 uppercase">
                        <span className="inline-block h-px w-6 bg-gradient-to-r from-sky-sapphire/60 to-transparent" />
                        Open Source
                    </span>
                    <h1 className="mt-5 text-wrap-balance text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl lg:text-7xl">The Complete Toolkit.</h1>
                    <p className="mt-6 max-w-2xl text-lg leading-relaxed text-gray-500 sm:text-xl">
                        From the schema-first server to the live client and framework adapters, explore the full collection of Lunora packages — built to work
                        together for a real-time, end-to-end typed backend on Cloudflare.
                    </p>
                </div>

                <div className="col-span-1 flex flex-col items-end justify-end gap-8">
                    <StatBlock label="Packages" value={packages.length.toString()} />
                    <StatBlock label="Categories" value={categoryCount.toString()} />
                    {totalWeeklyDownloads > 0 && <StatBlock label="Weekly Downloads" value={formatNumber(totalWeeklyDownloads)} />}
                </div>

                <div className="col-span-full flex flex-col gap-6 py-8 sm:flex-row sm:items-center sm:justify-between border-t bg-ivory border-gray-200 mt-12">
                    <CategoryFilter active={activeCategory} mode="light" onChange={setActiveCategory} />
                    <div className="relative">
                        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-300" />
                        <input
                            className="w-full border border-gray-200 bg-gray-50 py-2 pr-4 pl-9 font-mono text-sm text-gray-900 placeholder-gray-400 outline-none transition-colors focus:border-gray-400 sm:w-64"
                            onChange={(e) => {
                                setSearch(e.target.value);
                            }}
                            placeholder="Search packages..."
                            type="text"
                            value={search}
                        />
                    </div>
                </div>
            </Section>

            <div className="bg-background">
                <Section classes={{ childrenWrapper: "grid-cols-1 gap-0 sm:grid-cols-2 lg:grid-cols-3 items-stretch" }} gridLength={3} mode="dark">
                    {filteredPackages.map((pkg) => (
                        <PackageCard key={pkg.slug} pkg={pkg} weeklyDownloads={stats?.weeklyDownloads[pkg.slug] ?? 0} />
                    ))}
                    {filteredPackages.length === 0 && (
                        <div className="col-span-full flex flex-col items-center gap-4 py-20">
                            <p className="text-lg text-white/40">No packages found matching your criteria.</p>
                            <button
                                className="text-sm text-white/60 underline underline-offset-4 transition-colors hover:text-white"
                                onClick={() => {
                                    setActiveCategory("All");
                                    setSearch("");
                                }}
                                type="button"
                            >
                                Clear filters
                            </button>
                        </div>
                    )}
                </Section>
            </div>

            <Section classes={{ root: "pb-20" }} mode="light">
                <div className="col-span-1 hidden lg:block" />
                <div className="col-span-2 flex flex-col gap-10">
                    <SectionTitle
                        classes={{ root: "text-center" }}
                        description="Can't find what you're looking for? All Lunora packages are open source and built to work together. Check the documentation or join the community to get started."
                        mode="light"
                        position="center"
                        title="Build with confidence."
                    />
                    <div className="flex flex-col gap-0 sm:flex-row">
                        <HighlightLink className="-ml-px w-full border-r-0" icon={<ChevronRight />} mode="light" to="/docs">
                            Documentation
                        </HighlightLink>
                        <HighlightLink className="-ml-px w-full border-r-0" icon={<Package />} mode="light" to="/">
                            Home
                        </HighlightLink>
                    </div>
                </div>
            </Section>
        </>
    );
};

export default PackagesListing;
