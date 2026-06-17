import { createServerFn } from "@tanstack/react-start";

import prebuiltStats from "@/data/stats.json";

export interface MonthlyDataPoint {
    downloads: number;
    month: string;
}

export interface DownloadStats {
    contributors: number;
    monthlyChart: Record<string, MonthlyDataPoint[]>;
    stars: number;
    totalDownloads: Record<string, number>;
    weeklyDownloads: Record<string, number>;
}

export const getStats = createServerFn({
    method: "GET",
}).handler(async (): Promise<DownloadStats> => {
    return {
        contributors: prebuiltStats.contributors,
        monthlyChart: prebuiltStats.monthlyChart,
        stars: prebuiltStats.stars,
        totalDownloads: prebuiltStats.totalDownloads,
        weeklyDownloads: prebuiltStats.weeklyDownloads,
    };
});
