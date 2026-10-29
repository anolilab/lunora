// Emitted by Vite as a hashed static asset, so the packages pages read the
// prebuilt numbers from the CDN instead of calling a server function on every
// visit (each such call could land on a cold Netlify function).
import statsUrl from "@/data/stats.json?url";

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

export const getStats = async (): Promise<DownloadStats> => {
    const response = await fetch(statsUrl);

    if (!response.ok) {
        throw new Error(`Failed to load download stats: HTTP ${String(response.status)}`);
    }

    return (await response.json()) as DownloadStats;
};
