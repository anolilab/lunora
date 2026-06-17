import { ChevronDown } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Section from "@/components/sections/section";
import AnimatedNumber from "@/components/ui/animated/animated-number";
import type { DownloadStats, MonthlyDataPoint } from "@/server/stats";
import { getStats } from "@/server/stats";

const ALL_PACKAGES = "all";

const CHART_VIEW_WIDTH = 500;
const CHART_VIEW_HEIGHT = 250;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 40;
const CHART_HEIGHT = CHART_VIEW_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
const GRID_FRACTIONS = [0.25, 0.5, 0.75];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatMonth = (m: string) => {
    const [year, month] = m.split("-");

    return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
};

const DownloadChart: FC<{ data: MonthlyDataPoint[] }> = ({ data }) => {
    if (data.length === 0) {
        return null;
    }

    const maxDownloads = Math.max(...data.map((d) => d.downloads), 1);

    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * CHART_VIEW_WIDTH;
        const y = CHART_PAD_TOP + CHART_HEIGHT - (d.downloads / maxDownloads) * CHART_HEIGHT;

        return { x, y };
    });

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const areaPath = `${linePath} L ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM} L 0 ${CHART_VIEW_HEIGHT - CHART_PAD_BOTTOM} Z`;

    const firstMonth = data[0]?.month ?? "";
    const lastPoint = points[points.length - 1];

    return (
        <div className="relative h-full w-full">
            <motion.div animate={{ opacity: 1 }} className="absolute inset-0 h-full w-full" initial={{ opacity: 0 }} transition={{ duration: 1.5 }}>
                <svg className="h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}>
                    <defs>
                        <linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="hsl(258 80% 55%)" stopOpacity="0.15" />
                            <stop offset="100%" stopColor="hsl(258 80% 55%)" stopOpacity="0" />
                        </linearGradient>
                    </defs>

                    {GRID_FRACTIONS.map((fraction) => {
                        const y = CHART_PAD_TOP + CHART_HEIGHT * (1 - fraction);

                        return <line key={fraction} stroke="rgba(0,0,0,0.04)" strokeDasharray="4 4" x1="0" x2={CHART_VIEW_WIDTH} y1={y} y2={y} />;
                    })}

                    <path d={areaPath} fill="url(#chart-gradient)" />

                    <path d={linePath} fill="none" stroke="hsl(258 80% 55%)" strokeWidth="2" vectorEffect="non-scaling-stroke" />

                    {lastPoint && <circle className="animate-pulse" cx={lastPoint.x} cy={lastPoint.y} fill="hsl(258 80% 55%)" r="4" />}
                </svg>
            </motion.div>
            <div className="absolute right-6 bottom-3 left-6 flex justify-between md:right-10 md:left-10">
                <span className="font-mono text-sm text-gray-400">{formatMonth(firstMonth)}</span>
                <span className="font-mono text-sm text-gray-400">Today</span>
            </div>
        </div>
    );
};

const PackageDropdown: FC<{
    onChange: (value: string) => void;
    packages: string[];
    value: string;
}> = ({ onChange, packages, value }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const displayName = value === ALL_PACKAGES ? "All Packages" : `@lunora/${value}`;

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                className="inline-flex items-center gap-2 border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-sm transition-colors hover:bg-gray-50"
                onClick={() => {
                    setOpen(!open);
                }}
                type="button"
            >
                {displayName}
                <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>

            {open && (
                <div className="absolute left-0 z-50 mt-2 max-h-64 w-56 overflow-y-auto border border-gray-200 bg-white py-1 shadow-lg">
                    <button
                        className={`block w-full px-4 py-2 text-left text-sm transition-colors hover:bg-gray-50 ${value === ALL_PACKAGES ? "font-medium text-gray-900" : "text-gray-600"}`}
                        onClick={() => {
                            onChange(ALL_PACKAGES);
                            setOpen(false);
                        }}
                        type="button"
                    >
                        All Packages
                    </button>
                    {packages.map((pkg) => (
                        <button
                            className={`block w-full px-4 py-2 text-left text-sm transition-colors hover:bg-gray-50 ${value === pkg ? "font-medium text-gray-900" : "text-gray-600"}`}
                            key={pkg}
                            onClick={() => {
                                onChange(pkg);
                                setOpen(false);
                            }}
                            type="button"
                        >
                            @lunora/
                            {pkg}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

const INITIAL_STATS: DownloadStats = {
    contributors: 0,
    monthlyChart: {},
    stars: 0,
    totalDownloads: {},
    weeklyDownloads: {},
};

const useDownloadStats = (): DownloadStats => {
    const [stats, setStats] = useState(INITIAL_STATS);

    const fetchStats = useCallback(async () => {
        try {
            const data = await getStats();

            setStats(data);
        } catch {
            // Keep zeros on failure
        }
    }, []);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    return stats;
};

const sumValues = (record: Record<string, number>): number => {
    let total = 0;

    for (const value of Object.values(record)) {
        total += value;
    }

    return total;
};

const aggregateMonthlyChart = (chart: Record<string, MonthlyDataPoint[]>): MonthlyDataPoint[] => {
    const byMonth: Record<string, number> = {};

    for (const pkgData of Object.values(chart)) {
        for (const point of pkgData) {
            if (!byMonth[point.month]) {
                byMonth[point.month] = 0;
            }

            byMonth[point.month] += point.downloads;
        }
    }

    return Object.keys(byMonth)
        .toSorted()
        .map((month) => {
            return { downloads: byMonth[month], month };
        });
};

const Downloads: FC = () => {
    const stats = useDownloadStats();
    const [selectedPackage, setSelectedPackage] = useState(ALL_PACKAGES);

    const packages = useMemo(() => Object.keys(stats.totalDownloads).toSorted(), [stats.totalDownloads]);

    const chartData = useMemo(() => {
        if (selectedPackage === ALL_PACKAGES) {
            return aggregateMonthlyChart(stats.monthlyChart);
        }

        return stats.monthlyChart[selectedPackage] ?? [];
    }, [selectedPackage, stats.monthlyChart]);

    const totalDownloads = useMemo(() => {
        if (selectedPackage === ALL_PACKAGES) {
            return sumValues(stats.totalDownloads);
        }

        return stats.totalDownloads[selectedPackage] ?? 0;
    }, [selectedPackage, stats.totalDownloads]);

    const weeklyDownloads = useMemo(() => {
        if (selectedPackage === ALL_PACKAGES) {
            return sumValues(stats.weeklyDownloads);
        }

        return stats.weeklyDownloads[selectedPackage] ?? 0;
    }, [selectedPackage, stats.weeklyDownloads]);

    return (
        <Section classes={{ root: "pb-0" }} gridLength={2} mode="light">
            <div className="col-span-full">
                <h3 className="max-w-lg text-balance text-2xl font-bold tracking-tight text-gray-900 lg:text-3xl">Trusted by developers worldwide</h3>
            </div>

            <div className="col-span-full mt-10 border-t border-gray-200">
                <div className="grid grid-cols-1 divide-y divide-gray-200 md:grid-cols-2 md:divide-x md:divide-y-0">
                    <div className="flex flex-col justify-between gap-6 p-6 md:p-10">
                        <span className="flex items-center gap-2 text-sm text-gray-500">Total downloads</span>
                        <AnimatedNumber className="text-5xl font-bold tracking-tight text-gray-900 lg:text-6xl" suffix="+" value={totalDownloads} />
                    </div>

                    <div className="relative flex flex-col aspect-[5/3]">
                        <div className="absolute top-4 left-6 z-20 md:left-10">
                            <PackageDropdown onChange={setSelectedPackage} packages={packages} value={selectedPackage} />
                        </div>
                        <div className="relative flex-1">
                            <DownloadChart data={chartData} />
                        </div>
                    </div>
                </div>
            </div>

            <div className="col-span-full border-t border-b border-gray-200">
                <div className="grid grid-cols-1 divide-y divide-gray-200 md:grid-cols-4 md:divide-x md:divide-y-0">
                    <div className="col-span-2 flex flex-col gap-2 p-6 md:p-10">
                        <AnimatedNumber className="text-4xl font-bold tracking-tight text-gray-900" suffix="+" value={weeklyDownloads} />
                        <span className="text-sm text-gray-500">Weekly NPM downloads</span>
                    </div>
                    <div className="flex flex-col gap-2 p-6 md:p-10">
                        <AnimatedNumber className="text-4xl font-bold tracking-tight text-gray-900" suffix="+" value={stats.stars} />
                        <span className="text-sm text-gray-500">GitHub Stars</span>
                    </div>
                    <div className="flex flex-col gap-2 p-6 md:p-10">
                        <AnimatedNumber className="text-4xl font-bold tracking-tight text-gray-900" suffix="+" value={stats.contributors} />
                        <span className="text-sm text-gray-500">Contributors</span>
                    </div>
                </div>
            </div>
        </Section>
    );
};

export default Downloads;
