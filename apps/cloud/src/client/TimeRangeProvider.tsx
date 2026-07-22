import type { ReactElement, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { TimeRange, TimeRangePreset } from "./time-range";
import { DEFAULT_TIME_RANGE_PRESET, rangeForPreset, TIME_RANGE_PRESETS } from "./time-range";

/**
 * Shared time-range state for the observability tabs (GAPS.md ring 3). A tiny
 * context so Traces, Logs, and Metrics read one `[from, to]` window from the same
 * preset picker — pick 1h/24h/7d once and every tab reflows. The window is
 * snapshotted when the preset changes (a stable absolute range, not a per-render
 * moving target), which also keeps the live-query args stable between renders.
 */

interface TimeRangeContextValue extends TimeRange {
    preset: TimeRangePreset;
    setPreset: (preset: TimeRangePreset) => void;
}

const TimeRangeContext = createContext<null | TimeRangeContextValue>(null);

/** Provide the shared time-range window. `initialPreset` seeds the first window. */
export const TimeRangeProvider = ({
    children,
    initialPreset = DEFAULT_TIME_RANGE_PRESET,
}: {
    children: ReactNode;
    initialPreset?: TimeRangePreset;
}): ReactElement => {
    // Hold the absolute window in state and snapshot it (via `Date.now()`) only
    // where it's allowed to be impure: the lazy initializer (once, at mount) and
    // the `setPreset` event handler. Render stays pure — no `Date.now()` in the
    // render path — and `from`/`to` stay referentially stable between renders, so
    // they don't re-fire the live queries.
    const [range, setRange] = useState<{ preset: TimeRangePreset } & TimeRange>(() => ({
        preset: initialPreset,
        ...rangeForPreset(initialPreset, Date.now()),
    }));

    const setPreset = useCallback((preset: TimeRangePreset) => {
        setRange({ preset, ...rangeForPreset(preset, Date.now()) });
    }, []);

    const value = useMemo<TimeRangeContextValue>(() => ({ from: range.from, preset: range.preset, setPreset, to: range.to }), [range, setPreset]);

    return <TimeRangeContext.Provider value={value}>{children}</TimeRangeContext.Provider>;
};

/** Read the shared time-range window. Throws if used outside a {@link TimeRangeProvider}. */
export const useTimeRange = (): TimeRangeContextValue => {
    const value = useContext(TimeRangeContext);

    if (value === null) {
        throw new Error("useTimeRange must be used within a TimeRangeProvider");
    }

    return value;
};

/** The preset picker control (1h / 24h / 7d). Renders the shared segmented buttons. */
export const TimeRangePicker = (): ReactElement => {
    const { preset, setPreset } = useTimeRange();

    return (
        <div aria-label="Time range" className="time-range" role="group">
            {TIME_RANGE_PRESETS.map((spec) => (
                <button
                    aria-pressed={spec.id === preset}
                    className={`time-range-btn${spec.id === preset ? " active" : ""}`}
                    key={spec.id}
                    onClick={() => setPreset(spec.id)}
                    type="button"
                >
                    {spec.label}
                </button>
            ))}
        </div>
    );
};
