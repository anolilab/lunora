"use client";

import { useLoaderData } from "@tanstack/react-router";
import { Check, ChevronRight, Copy, Download, ExternalLink, Terminal } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Pill, SectionHead } from "@/components/sections/langbase";
import JsonLd from "@/components/seo/json-ld";
import AnimatedNumber from "@/components/ui/animated/animated-number";
import type { AccentColor } from "@/data/packages";
import { Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import posthog from "@/lib/posthog";
import { cn, formatNumber } from "@/lib/utils";
import type { DownloadStats, MonthlyDataPoint } from "@/server/stats";
import { getStats } from "@/server/stats";

const accentText: Record<AccentColor, string> = {
    "crimson-energy": "text-crimson-energy",
    "royal-amethyst": "text-royal-amethyst",
    "sky-sapphire": "text-sky-sapphire",
};

const chartConfig: Record<AccentColor, { color: string; id: string }> = {
    "crimson-energy": { color: "hsl(330 80% 64%)", id: "chart-rose" },
    "royal-amethyst": { color: "hsl(256 72% 68%)", id: "chart-violet" },
    "sky-sapphire": { color: "hsl(186 84% 56%)", id: "chart-cyan" },
};

const CopyButton: FC<{ text: string }> = ({ text }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        const run = async () => {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                // Permission denied, or no secure context. Nothing was copied,
                // so neither the check mark nor the event should claim it was.
                return;
            }

            posthog.capture("install_command_copied", { location: "package_detail" });
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 2000);
        };

        void run();
    }, [text]);

    return (
        <button
            aria-label="Copy install command"
            className="absolute top-1/2 right-3 -translate-y-1/2 p-1.5 text-ink-faint transition-colors hover:text-ink"
            onClick={handleCopy}
            type="button"
        >
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
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

/** First month the download chart plots. `YYYY-MM`, compared as a string. */
const CHART_START_MONTH = "2026-01";

const formatMonth = (m: string): string => {
    const [year, month] = m.split("-");

    return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
};

const MiniChart: FC<{ accentColor: AccentColor; data: MonthlyDataPoint[] }> = ({ accentColor, data }) => {
    const { color, id } = chartConfig[accentColor];

    const { areaPath, firstMonth, lastPoint, linePath } = useMemo(() => {
        const maxDownloads = Math.max(...data.map((d) => d.downloads), 1);
        const points = data.map((d, i) => {
            return {
                x: data.length > 1 ? (i / (data.length - 1)) * CHART_VIEW_WIDTH : CHART_VIEW_WIDTH / 2,
                y: CHART_PAD_TOP + CHART_HEIGHT - (d.downloads / maxDownloads) * CHART_HEIGHT,
            };
        });
        const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
        const area = `${line} L ${String(CHART_VIEW_WIDTH)} ${String(CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM)} L 0 ${String(CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM)} Z`;

        return { areaPath: area, firstMonth: data[0]?.month ?? "", lastPoint: points[points.length - 1], linePath: line };
    }, [data]);

    return (
        <div className="relative size-full">
            <motion.div animate={{ opacity: 1 }} className="absolute inset-0 size-full" initial={{ opacity: 0 }} transition={{ duration: 1.5 }}>
                <svg className="size-full" preserveAspectRatio="none" viewBox={`0 0 ${String(CHART_VIEW_WIDTH)} ${String(CHART_VIEW_HEIGHT)}`}>
                    <defs>
                        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
                            <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    {GRID_FRACTIONS.map((fraction) => {
                        const y = CHART_PAD_TOP + CHART_HEIGHT * (1 - fraction);

                        return <line key={fraction} stroke="rgba(255,255,255,0.06)" strokeDasharray="4 4" x1="0" x2={CHART_VIEW_WIDTH} y1={y} y2={y} />;
                    })}
                    <path d={areaPath} fill={`url(#${id})`} />
                    <path d={linePath} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <circle className="animate-pulse" cx={lastPoint.x} cy={lastPoint.y} fill={color} r="4" />
                </svg>
            </motion.div>
            <div className="absolute right-4 bottom-1 left-4 flex justify-between font-mono text-xs text-ink-faint">
                <span>{formatMonth(firstMonth)}</span>
                <span>Today</span>
            </div>
        </div>
    );
};

const PackageDetail: FC = () => {
    const { pkg } = useLoaderData({ from: "/packages/$slug" });
    const [stats, setStats] = useState<DownloadStats | null>(null);
    const accent = accentText[pkg.accentColor];

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

    const weeklyDownloads = stats?.weeklyDownloads[pkg.slug] ?? 0;
    const totalDownloads = stats?.totalDownloads[pkg.slug] ?? 0;
    // The npm range API answers for every month the registry has existed, so the
    // series opens with five years of zeros before the first release and the real
    // curve is squashed into the last few pixels. Start at the year the packages
    // were first published.
    const chartData = useMemo(() => (stats?.monthlyChart[pkg.slug] ?? []).filter((point) => point.month >= CHART_START_MONTH), [stats, pkg.slug]);
    const installCommand = `npm install ${pkg.npmName}`;
    const downloadField = totalDownloads > 0 ? { downloadCount: totalDownloads } : {};

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <JsonLd
                data={{
                    "@type": "SoftwareApplication",
                    applicationCategory: "DeveloperApplication",
                    author: { "@type": "Organization", name: "Lunora", url: "https://lunora.sh" },
                    description: pkg.description,
                    ...downloadField,
                    license: "https://opensource.org/licenses/MIT",
                    name: pkg.name,
                    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
                    operatingSystem: "Cross-platform",
                    programmingLanguage: "TypeScript",
                    url: `https://lunora.sh/packages/${pkg.slug}`,
                }}
            />

            <ArticleHeader
                actions={
                    <>
                        <a
                            className={cn(
                                "inline-flex items-center gap-1.5 border-b border-hairline-strong pb-0.5 font-mono text-xs transition-colors hover:opacity-70",
                                accent,
                            )}
                            href={`https://www.npmjs.com/package/${pkg.npmName}`}
                            rel="noreferrer"
                            target="_blank"
                        >
                            npm
                            <ExternalLink className="size-3" />
                        </a>
                        <a
                            className="inline-flex items-center gap-1.5 border-b border-hairline-strong pb-0.5 font-mono text-xs text-ink-muted transition-colors hover:text-ink"
                            href={`https://github.com/anolilab/lunora/tree/alpha/packages/${pkg.slug}`}
                            rel="noreferrer"
                            target="_blank"
                        >
                            GitHub
                            <ExternalLink className="size-3" />
                        </a>
                    </>
                }
                breadcrumb={[{ label: "Packages", to: "/packages" }, { label: pkg.category }]}
                lead={pkg.description}
                meta="Package reference"
                title={pkg.name}
            />

            <section data-nav-theme="dark">
                <Shell className="flex flex-col gap-3 py-10 sm:flex-row sm:items-center">
                    <div className="relative w-full sm:max-w-md">
                        <div className="flex items-center gap-3 border border-hairline bg-[var(--site-console)] px-4 py-3 pr-12 font-mono text-sm text-ink-muted">
                            <Terminal className={cn("size-4 shrink-0", accent)} />
                            {installCommand}
                        </div>
                        <CopyButton text={installCommand} />
                    </div>
                    {pkg.docsPath ? (
                        <Pill primary to={pkg.docsPath}>
                            Get started
                            <ChevronRight className="size-4" />
                        </Pill>
                    ) : null}
                </Shell>
            </section>

            {/* stats */}
            <section data-nav-theme="dark">
                <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px border-hairline sm:grid-cols-4 lg:border-x-0">
                    <div className="flex flex-col gap-1 bg-wash p-8">
                        <span className="font-mono text-2xl font-semibold tracking-tight text-ink">
                            {weeklyDownloads > 0 ? formatNumber(weeklyDownloads) : "—"}
                        </span>
                        <span className="flex items-center gap-1.5 text-sm text-ink-faint">
                            <Download className="size-3.5" />
                            weekly
                        </span>
                    </div>
                    <div className="flex flex-col gap-1 bg-wash p-8">
                        <span className="font-mono text-2xl font-semibold tracking-tight text-ink">
                            {totalDownloads > 0 ? formatNumber(totalDownloads) : "—"}
                        </span>
                        <span className="text-sm text-ink-faint">total downloads</span>
                    </div>
                    <div className="flex flex-col gap-1 bg-wash p-8">
                        <span className="font-mono text-2xl font-semibold tracking-tight text-ink">{pkg.features.length}</span>
                        <span className="text-sm text-ink-faint">key features</span>
                    </div>
                    <div className="flex flex-col gap-1 bg-wash p-8">
                        <span className="truncate font-mono text-sm font-medium text-ink">{pkg.npmName}</span>
                        <span className="text-sm text-ink-faint">npm package</span>
                    </div>
                </div>
            </section>

            {pkg.features.length > 0 ? (
                <>
                    <HatchSpacer />

                    {/* features */}
                    <section data-nav-theme="dark">
                        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-0">
                            <h2 className="text-2xl font-semibold tracking-tight text-ink">Features</h2>
                            <div className="mt-10 grid gap-px border border-hairline sm:grid-cols-2 lg:border-x-0">
                                {pkg.features.map((feature) => (
                                    <div className="group flex items-center gap-4 bg-wash px-6 py-6 transition-colors hover:bg-panel/[0.028]" key={feature}>
                                        <span className="flex size-8 shrink-0 items-center justify-center border border-hairline bg-wash">
                                            <Check className={cn("size-4", accent)} />
                                        </span>
                                        <h3 className="text-sm font-medium text-ink-muted transition-colors group-hover:text-ink">{feature}</h3>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>
                </>
            ) : null}

            {/* downloads */}
            {chartData.length > 0 ? (
                <>
                    <HatchSpacer />
                    <section data-nav-theme="dark">
                        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-0">
                            <h2 className="text-2xl font-semibold tracking-tight text-ink">Downloads</h2>
                            <div className="mt-8 grid grid-cols-2 gap-px border border-hairline sm:grid-cols-2 lg:border-x-0">
                                <div className="flex flex-col gap-2 bg-wash p-8">
                                    <AnimatedNumber className="text-3xl font-semibold tracking-tight text-ink" suffix="+" value={weeklyDownloads} />
                                    <span className="flex items-center gap-1.5 text-sm text-ink-faint">
                                        <Download className="size-3.5" />
                                        Weekly downloads
                                    </span>
                                </div>
                                <div className="flex flex-col gap-2 bg-wash p-8">
                                    <AnimatedNumber className="text-3xl font-semibold tracking-tight text-ink" suffix="+" value={totalDownloads} />
                                    <span className="text-sm text-ink-faint">Total downloads</span>
                                </div>
                            </div>
                            <div className="mt-px aspect-[5/2] border border-hairline bg-wash lg:border-x-0">
                                <MiniChart accentColor={pkg.accentColor} data={chartData} />
                            </div>
                        </div>
                    </section>
                </>
            ) : null}

            <HatchSpacer />

            {/* CTA */}
            <section data-nav-theme="dark">
                <div className="mx-auto max-w-6xl px-5 py-24 lg:px-0">
                    <SectionHead
                        eyebrow="Get started"
                        subtitle={`Read the full documentation to learn how to install, configure, and use ${pkg.name} in your project.`}
                        title="Ready to get started?"
                    />
                    <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                        {pkg.docsPath ? (
                            <Pill primary to={pkg.docsPath}>
                                Read the docs
                                <ChevronRight className="size-4" />
                            </Pill>
                        ) : null}
                        <Pill to="/packages">Explore all packages</Pill>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default PackageDetail;
