"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Download, Search } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Pill, SectionHead } from "@/components/sections/langbase";
import type { AccentColor, Category, PackageInfo } from "@/data/packages";
import { categories, packages } from "@/data/packages";
import { cn, formatNumber } from "@/lib/utils";
import type { DownloadStats } from "@/server/stats";
import { getStats } from "@/server/stats";

const accentText: Record<AccentColor, string> = {
    "crimson-energy": "text-crimson-energy",
    "royal-amethyst": "text-royal-amethyst",
    "sky-sapphire": "text-sky-sapphire",
};

const accentBadge: Record<AccentColor, string> = {
    "crimson-energy": "bg-crimson-energy/15 text-crimson-energy",
    "royal-amethyst": "bg-royal-amethyst/15 text-royal-amethyst",
    "sky-sapphire": "bg-sky-sapphire/15 text-sky-sapphire",
};

const PackageCard: FC<{ pkg: PackageInfo; weeklyDownloads: number }> = ({ pkg, weeklyDownloads }) => (
    <Link
        className="group flex h-full flex-col gap-4 bg-white/[0.012] p-6 transition-colors hover:bg-white/[0.03]"
        params={{ slug: pkg.slug }}
        to="/packages/$slug"
    >
        <div className="flex items-center justify-between">
            <span className={cn("inline-block px-2.5 py-0.5 font-mono text-[11px] font-medium", accentBadge[pkg.accentColor])}>{pkg.category}</span>
            {weeklyDownloads > 0 ? (
                <span className="flex items-center gap-1.5 font-mono text-xs text-white/30">
                    <Download className="size-3" />
                    {formatNumber(weeklyDownloads)}/wk
                </span>
            ) : null}
        </div>
        <h3 className="text-lg font-semibold tracking-tight text-white">{pkg.name}</h3>
        <p className="line-clamp-2 text-sm leading-relaxed text-white/45 transition-colors group-hover:text-white/60">{pkg.description}</p>
        <div className="mt-auto flex items-center gap-2 pt-2">
            <span className={cn("text-sm font-medium", accentText[pkg.accentColor])}>Learn more</span>
            <ArrowRight className={cn("size-3.5 transition-transform group-hover:translate-x-1", accentText[pkg.accentColor])} />
        </div>
    </Link>
);

const CategoryFilter: FC<{ active: Category; onChange: (category: Category) => void }> = ({ active, onChange }) => (
    <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
            <button
                className={cn(
                    "border px-4 py-1.5 font-mono text-xs font-medium transition-colors",
                    active === cat ? "border-white/20 bg-white/10 text-white" : "border-white/[0.1] text-white/45 hover:border-white/20 hover:text-white",
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

const PackagesListing: FC = () => {
    const [activeCategory, setActiveCategory] = useState<Category>("All");
    const [search, setSearch] = useState("");
    const [stats, setStats] = useState<DownloadStats | null>(null);

    const fetchStats = useCallback(async () => {
        try {
            setStats(await getStats());
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        void fetchStats();
    }, [fetchStats]);

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
        <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
            {/* vertical guide lines */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
            />

            {/* hero + filters */}
            <section className="border-t border-white/[0.08]" data-nav-theme="dark">
                <div className="mx-auto max-w-6xl px-5 pt-32 pb-10 lg:px-0">
                    <SectionHead
                        eyebrow="Open source"
                        subtitle="From the schema-first server to the live client and framework adapters — explore the full collection of Lunora packages, built to work together."
                        title="The complete toolkit"
                    />
                    <div className="mt-12 flex flex-col gap-4 border-t border-white/[0.08] pt-8 sm:flex-row sm:items-center sm:justify-between">
                        <CategoryFilter active={activeCategory} onChange={setActiveCategory} />
                        <div className="relative">
                            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/30" />
                            <input
                                className="w-full border border-white/[0.1] bg-white/[0.02] py-2 pr-4 pl-9 font-mono text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/25 sm:w-64"
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                }}
                                placeholder="Search packages…"
                                type="text"
                                value={search}
                            />
                        </div>
                    </div>
                </div>
            </section>

            <HatchSpacer />

            {/* grid */}
            <section className="border-t border-white/[0.08]" data-nav-theme="dark">
                <div className="mx-auto max-w-6xl px-5 py-12 lg:px-0">
                    {filteredPackages.length > 0 ? (
                        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                            {filteredPackages.map((pkg) => (
                                <PackageCard key={pkg.slug} pkg={pkg} weeklyDownloads={stats?.weeklyDownloads[pkg.slug] ?? 0} />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-4 py-20">
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
                </div>
            </section>

            <HatchSpacer />

            {/* CTA */}
            <section className="border-t border-white/[0.08]" data-nav-theme="dark">
                <div className="mx-auto max-w-6xl px-5 py-24 lg:px-0">
                    <SectionHead
                        eyebrow="Get started"
                        subtitle="Every Lunora package is open source and built to work together. Check the docs or jump back home to start building."
                        title="Build with confidence"
                    />
                    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                        <Pill primary to="/docs">
                            Documentation
                        </Pill>
                        <Pill to="/">Home</Pill>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default PackagesListing;
