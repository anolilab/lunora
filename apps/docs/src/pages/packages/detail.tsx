import { Link, useLoaderData } from "@tanstack/react-router";
import { Check, ChevronRight, Copy, Download, ExternalLink, Terminal } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";
import JsonLd from "@/components/seo/json-ld";
import AnimatedNumber from "@/components/ui/animated/animated-number";
import HighlightLink from "@/components/ui/highlight-link";
import type { AccentColor } from "@/data/packages";
import { cn, formatNumber } from "@/lib/utils";
import type { DownloadStats, MonthlyDataPoint } from "@/server/stats";
import { getStats } from "@/server/stats";

const accentConfig: Record<
    AccentColor,
    {
        badge: string;
        badgeLight: string;
        border: string;
        borderLight: string;
        feature: string;
        featureLight: string;
        link: string;
        patternColor: "sky-sapphire" | "crimson-energy" | "royal-amethyst";
        text: string;
    }
> = {
    "crimson-energy": {
        badge: "bg-crimson-energy/20 text-crimson-energy",
        badgeLight: "bg-crimson-energy/10 text-crimson-energy",
        border: "border-crimson-energy/30",
        borderLight: "border-crimson-energy/20",
        feature: "bg-crimson-energy/40",
        featureLight: "bg-crimson-energy/30",
        link: "text-crimson-energy",
        patternColor: "crimson-energy",
        text: "text-crimson-energy",
    },
    "royal-amethyst": {
        badge: "bg-royal-amethyst/20 text-royal-amethyst",
        badgeLight: "bg-royal-amethyst/10 text-royal-amethyst",
        border: "border-royal-amethyst/30",
        borderLight: "border-royal-amethyst/20",
        feature: "bg-royal-amethyst/40",
        featureLight: "bg-royal-amethyst/30",
        link: "text-royal-amethyst",
        patternColor: "royal-amethyst",
        text: "text-royal-amethyst",
    },
    "sky-sapphire": {
        badge: "bg-sky-sapphire/20 text-sky-sapphire",
        badgeLight: "bg-sky-sapphire/10 text-sky-sapphire",
        border: "border-sky-sapphire/30",
        borderLight: "border-sky-sapphire/20",
        feature: "bg-sky-sapphire/40",
        featureLight: "bg-sky-sapphire/30",
        link: "text-sky-sapphire",
        patternColor: "sky-sapphire",
        text: "text-sky-sapphire",
    },
};

const gradientIds: Record<AccentColor, { color: string; id: string }> = {
    "crimson-energy": { color: "hsl(1 76% 55%)", id: "chart-gradient-crimson" },
    "royal-amethyst": { color: "hsl(283 45% 47%)", id: "chart-gradient-amethyst" },
    "sky-sapphire": { color: "hsl(212 100% 45%)", id: "chart-gradient-sapphire" },
};

const CopyButton: FC<{ text: string }> = ({ text }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(setCopied, 2000, false);
    }, [text]);

    return (
        <button
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            onClick={handleCopy}
            type="button"
        >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
    );
};

const CHART_VIEW_WIDTH = 500;
const CHART_VIEW_HEIGHT = 200;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 30;
const CHART_HEIGHT = CHART_VIEW_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
const GRID_FRACTIONS = [0.25, 0.5, 0.75];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatMonth = (m: string) => {
    const [year, month] = m.split("-");

    return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
};

const MiniChart: FC<{ accentColor: AccentColor; data: MonthlyDataPoint[] }> = memo(({ accentColor, data }) => {
    if (data.length === 0) {
        return null;
    }

    const { color, id } = gradientIds[accentColor];

    const { areaPath, firstMonth, lastPoint, linePath } = useMemo(() => {
        const maxDownloads = Math.max(...data.map((d) => d.downloads), 1);

        const points = data.map((d, i) => {
            const x = (i / (data.length - 1)) * CHART_VIEW_WIDTH;
            const y = CHART_PAD_TOP + CHART_HEIGHT - (d.downloads / maxDownloads) * CHART_HEIGHT;

            return { x, y };
        });

        const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
        const area = `${line} L ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM} L 0 ${CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM} Z`;

        return {
            areaPath: area,
            firstMonth: data[0]?.month ?? "",
            lastPoint: points[points.length - 1],
            linePath: line,
        };
    }, [data]);

    return (
        <div className="relative h-full w-full">
            <motion.div animate={{ opacity: 1 }} className="absolute inset-0 h-full w-full" initial={{ opacity: 0 }} transition={{ duration: 1.5 }}>
                <svg className="h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}>
                    <defs>
                        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity="0.12" />
                            <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                    </defs>

                    {GRID_FRACTIONS.map((fraction) => {
                        const y = CHART_PAD_TOP + CHART_HEIGHT * (1 - fraction);

                        return <line key={fraction} stroke="rgba(0,0,0,0.04)" strokeDasharray="4 4" x1="0" x2={CHART_VIEW_WIDTH} y1={y} y2={y} />;
                    })}

                    <path d={areaPath} fill={`url(#${id})`} />
                    <path d={linePath} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />

                    {lastPoint && <circle className="animate-pulse" cx={lastPoint.x} cy={lastPoint.y} fill={color} r="4" />}
                </svg>
            </motion.div>
            <div className="absolute right-4 bottom-1 left-4 flex justify-between">
                <span className="font-mono text-xs text-gray-400">{formatMonth(firstMonth)}</span>
                <span className="font-mono text-xs text-gray-400">Today</span>
            </div>
        </div>
    );
});

const PackageDetail: FC = () => {
    const { pkg } = useLoaderData({ from: "/packages/$slug" });
    const [stats, setStats] = useState<DownloadStats | null>(null);
    const accent = accentConfig[pkg.accentColor];

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

    const weeklyDownloads = stats?.weeklyDownloads[pkg.slug] ?? 0;
    const totalDownloads = stats?.totalDownloads[pkg.slug] ?? 0;
    const chartData = useMemo(() => stats?.monthlyChart[pkg.slug] ?? [], [stats, pkg.slug]);

    const installCommand = `npm install ${pkg.npmName}`;

    return (
        <>
            <JsonLd
                data={{
                    "@type": "SoftwareApplication",
                    applicationCategory: "DeveloperApplication",
                    author: { "@type": "Organization", name: "Lunora", url: "https://lunora.sh" },
                    description: pkg.description,
                    ...(totalDownloads > 0 ? { downloadCount: totalDownloads } : {}),
                    license: "https://opensource.org/licenses/MIT",
                    name: pkg.name,
                    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
                    operatingSystem: "Cross-platform",
                    programmingLanguage: "TypeScript",
                    url: `https://lunora.sh/packages/${pkg.slug}`,
                }}
            />

            <Section classes={{ childrenWrapper: "gap-y-0", root: "pt-36 pb-0" }} mode="light" patternColor={accent.patternColor} patternPosition="bottom">
                <div className="col-span-full mb-10 flex items-center gap-3">
                    <Link className="font-mono text-sm text-gray-400 transition-colors hover:text-gray-600" to="/packages">
                        Packages
                    </Link>
                    <span className="text-gray-300">/</span>
                    <span className={cn("inline-flex items-center gap-1.5 px-3 py-1 font-mono text-xs font-medium", accent.badgeLight)}>{pkg.category}</span>
                </div>

                <div className="col-span-3">
                    <h1 className="text-wrap-balance text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl lg:text-7xl">{pkg.name}</h1>
                    <p className="mt-6 max-w-2xl text-lg leading-relaxed text-gray-500 sm:text-xl">{pkg.description}</p>
                </div>

                <div className="col-span-1 flex flex-col items-end justify-end gap-6">
                    <div className="flex items-center gap-3">
                        <a
                            className={cn(
                                "inline-flex items-center gap-1.5 border-b pb-0.5 font-mono text-xs font-medium transition-colors hover:opacity-70",
                                accent.borderLight,
                                accent.text,
                            )}
                            href={`https://www.npmjs.com/package/${pkg.npmName}`}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            npm
                            <ExternalLink className="h-3 w-3" />
                        </a>
                        <a
                            className="inline-flex items-center gap-1.5 border-b border-gray-300 pb-0.5 font-mono text-xs font-medium text-gray-500 transition-colors hover:text-gray-700"
                            href={`https://github.com/anolilab/lunora/tree/alpha/packages/${pkg.slug}`}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            GitHub
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    </div>
                </div>

                <div className="col-span-full mt-10 border-t border-gray-200 pt-10">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                        <div className="relative w-full md:w-6/12">
                            <div className="flex items-center gap-3 border border-gray-200 bg-white px-4 py-3 pr-12 font-mono text-sm text-gray-600">
                                <Terminal className={cn("h-4 w-4 shrink-0", accent.text)} />
                                {installCommand}
                            </div>
                            <CopyButton text={installCommand} />
                        </div>
                        <div className="grow" />
                        <HighlightLink className="w-3/12" icon={<ChevronRight />} mode="light" to={pkg.docsPath}>
                            Get Started
                        </HighlightLink>
                    </div>
                </div>

                <div className="col-span-full border-t border-gray-200 mt-10">
                    <div className="grid grid-cols-2 divide-x divide-gray-200 sm:grid-cols-4">
                        <div className="flex flex-col gap-1 py-8 pr-6">
                            <span className="font-mono text-2xl font-bold tracking-tight text-gray-900">
                                {weeklyDownloads > 0 ? formatNumber(weeklyDownloads) : "--"}
                            </span>
                            <span className="flex items-center gap-1.5 text-sm text-gray-400">
                                <Download className="h-3.5 w-3.5" />
                                weekly
                            </span>
                        </div>
                        <div className="flex flex-col gap-1 py-8 px-6">
                            <span className="font-mono text-2xl font-bold tracking-tight text-gray-900">
                                {totalDownloads > 0 ? formatNumber(totalDownloads) : "--"}
                            </span>
                            <span className="text-sm text-gray-400">total downloads</span>
                        </div>
                        <div className="flex flex-col gap-1 py-8 px-6">
                            <span className="font-mono text-2xl font-bold tracking-tight text-gray-900">{pkg.features.length}</span>
                            <span className="text-sm text-gray-400">key features</span>
                        </div>
                        <div className="flex flex-col gap-1 py-8 pl-6">
                            <span className="font-mono text-sm font-medium text-gray-900">{pkg.npmName}</span>
                            <span className="text-sm text-gray-400">npm package</span>
                        </div>
                    </div>
                </div>
            </Section>

            <Section mode="light" patternColor={accent.patternColor} patternPosition="bottom">
                <div className="col-span-full">
                    <h2 className="mb-8 flex items-center gap-2 font-mono text-sm tracking-wider text-gray-400 uppercase">
                        <span className={cn("inline-block h-px w-6 bg-gradient-to-r to-transparent", accent.featureLight)} />
                        Features
                    </h2>
                </div>
                <div className="col-span-full grid grid-cols-1 border-y border-gray-200 sm:grid-cols-2">
                    {pkg.features.map((feature, index) => (
                        <div
                            className={cn(
                                "group/feature relative flex items-center gap-4 px-0 py-6 transition-all duration-300 bg-ivory sm:pl-8",
                                index % 2 !== 1 && "sm:border-r sm:border-gray-200",
                                index >= 2 && "border-t border-gray-200",
                            )}
                            key={feature}
                        >
                            <div
                                className={cn(
                                    "flex h-8 w-8 shrink-0 items-center justify-center transition-colors duration-300 group-hover/feature:scale-105",
                                    accent.badgeLight,
                                )}
                            >
                                <Check className="h-4 w-4" />
                            </div>
                            <h3 className="text-sm font-medium text-gray-700 transition-colors duration-300 group-hover/feature:text-gray-900">{feature}</h3>
                        </div>
                    ))}
                </div>
            </Section>

            <div className="bg-background">
                <Section mode="dark" patternColor="ivory">
                    <div className="col-span-full">
                        <h2 className="mb-8 text-2xl font-bold tracking-tight text-white">Downloads</h2>
                    </div>
                    <div className="col-span-full border-t border-white/6">
                        <div className="grid grid-cols-1 md:grid-cols-4">
                            <div className="flex flex-col gap-2 p-8 col-span-1">
                                <AnimatedNumber className="text-3xl font-bold tracking-tight text-white" suffix="+" value={weeklyDownloads} />
                                <span className="flex items-center gap-1.5 text-sm text-white/40">
                                    <Download className="h-3.5 w-3.5" />
                                    Weekly downloads
                                </span>
                            </div>
                            <div className="flex flex-col gap-2 p-8 col-span-1">
                                <AnimatedNumber className="text-3xl font-bold tracking-tight text-white" suffix="+" value={totalDownloads} />
                                <span className="text-sm text-white/40">Total downloads</span>
                            </div>
                            <div className="flex flex-col col-span-2 gap-2 p-8 bg-background">
                                <span className="text-3xl font-bold tracking-tight text-white">{pkg.npmName}</span>
                                <span className="text-sm text-white/40">npm package</span>
                            </div>
                        </div>
                        {chartData.length > 0 && (
                            <div className="border-y border-white/6 bg-background aspect-[5/2]">
                                <MiniChart accentColor={pkg.accentColor} data={chartData} />
                            </div>
                        )}
                    </div>
                </Section>
            </div>

            <Section mode="light">
                <div className="col-span-4 flex flex-col gap-16">
                    <SectionTitle
                        classes={{ root: "text-center" }}
                        description={`Read the full documentation to learn how to install, configure, and use ${pkg.name} in your project.`}
                        position="center"
                        title="Ready to get started?"
                    />
                    <div className="flex flex-row">
                        <HighlightLink className="-ml-px w-6/12 border-r-0" icon={<ChevronRight />} mode="light" to={pkg.docsPath}>
                            Read the Docs
                        </HighlightLink>
                        <HighlightLink className="w-6/12 border-r-0" icon={<ChevronRight />} mode="light" to="/packages">
                            Explore All Packages
                        </HighlightLink>
                    </div>
                </div>
            </Section>
        </>
    );
};

export default PackageDetail;
