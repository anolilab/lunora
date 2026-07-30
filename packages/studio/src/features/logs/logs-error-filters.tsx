import type { ReactElement } from "react";

import { LOG_LEVEL_ORDER } from "../../../../../shared/log-event";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import type { LogLevel } from "../../lib/admin";
import { cn } from "../../lib/utils";

/**
 * One level chip in the multi-select. Extracted so each chip owns a stable,
 * `useCallback`-bound click handler (no fresh closure per render of the map).
 */
const LevelToggle = ({ level, onToggle, selected }: LevelToggleProps): ReactElement => {
    const onClick = (): void => {
        onToggle(level);
    };

    return (
        <button
            aria-pressed={selected}
            className={cn("rounded-md border px-2 py-1 text-xs", selected ? "border-border bg-muted font-medium" : "border-input text-muted-foreground")}
            data-testid={`logs-level-${level}`}
            onClick={onClick}
            type="button"
        >
            {level}
        </button>
    );
};

interface LevelToggleProps {
    readonly level: LogLevel;
    /** Lifts the per-item click out of the map so the row carries no inline closure. */
    readonly onToggle: (level: LogLevel) => void;
    readonly selected: boolean;
}

/**
 * Filters for the error view: full-text search, path, time range, the level
 * toggles, and the summary switch.
 *
 * Its own component because these controls exist only in this view and read
 * nothing the requests view uses — inline they sat next to a second, unrelated
 * filter bar guarded by the opposite condition.
 */
const LogsErrorFilters = ({
    levelFilter,
    onLogPathChange,
    onSearchChange,
    onTimeRangeChange,
    onToggleLevel,
    onToggleSummary,
    pathFilter,
    search,
    showSummary,
    timeRange,
}: {
    /** Levels currently included; empty means every level. */
    readonly levelFilter: ReadonlySet<LogLevel>;
    readonly onLogPathChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly onSearchChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly onTimeRangeChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    readonly onToggleLevel: (level: LogLevel) => void;
    readonly onToggleSummary: () => void;
    readonly pathFilter: string;
    readonly search: string;
    readonly showSummary: boolean;
    readonly timeRange: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Input
                aria-label={t("Search messages")}
                className="h-8 w-48"
                data-testid="lg-search"
                onChange={onSearchChange}
                placeholder={t("search message")}
                value={search}
            />
            <Input
                aria-label={t("Function path")}
                className="h-8 w-40"
                data-testid="logs-path-filter"
                onChange={onLogPathChange}
                placeholder={t("filter path")}
                value={pathFilter}
            />
            <div aria-label={t("Level filter")} className="inline-flex items-center gap-1" data-testid="logs-level-filter" role="group">
                {LOG_LEVEL_ORDER.map((level) => (
                    <LevelToggle key={level} level={level} onToggle={onToggleLevel} selected={levelFilter.has(level)} />
                ))}
            </div>
            <select
                aria-label={t("Time range")}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                data-testid="logs-time-range"
                onChange={onTimeRangeChange}
                value={timeRange}
            >
                <option value="all">{t("All time")}</option>
                <option value="5m">{t("Last 5m")}</option>
                <option value="15m">{t("Last 15m")}</option>
                <option value="1h">{t("Last hour")}</option>
            </select>
            <button
                aria-pressed={showSummary}
                className={cn("h-8 rounded-md border px-3 text-sm", showSummary ? "border-border bg-muted font-medium" : "border-input text-muted-foreground")}
                data-testid="logs-summary-toggle"
                onClick={onToggleSummary}
                type="button"
            >
                {showSummary ? t("List") : t("Summary")}
            </button>
        </div>
    );
};

export { LogsErrorFilters };
