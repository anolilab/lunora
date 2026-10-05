import type { ReactElement, ReactNode } from "react";
import { createContext, use, useState } from "react";

import { captureEvent } from "./analytics";
import { useScreen } from "./tabs";
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
    const [range, setRange] = useState<TimeRange & { preset: TimeRangePreset }>(() => {
        return {
            preset: initialPreset,
            ...rangeForPreset(initialPreset, Date.now()),
        };
    });

    const setPreset = (preset: TimeRangePreset): void => {
        setRange({ preset, ...rangeForPreset(preset, Date.now()) });
    };

    // Not memoized by hand: React Compiler caches this object on the window it
    // reads (see vite.config.ts). The identity still matters for the same reason
    // it always did — an ancestor re-render handing consumers a new context value
    // reflows Traces, Logs and Metrics for nothing — the compiler is just what
    // keeps it stable now.
    const value: TimeRangeContextValue = { from: range.from, preset: range.preset, setPreset, to: range.to };

    return <TimeRangeContext value={value}>{children}</TimeRangeContext>;
};

/** Read the shared time-range window. Throws if used outside a {@link TimeRangeProvider}. */
export const useTimeRange = (): TimeRangeContextValue => {
    const value = use(TimeRangeContext);

    if (value === null) {
        throw new Error("useTimeRange must be used within a TimeRangeProvider");
    }

    return value;
};

/** The preset picker control (1h / 24h / 7d). Renders the shared segmented buttons. */
export const TimeRangePicker = (): ReactElement => {
    const { preset, setPreset } = useTimeRange();
    // Read here, in the leaf, rather than in the provider: the provider sits
    // above the `Outlet`, and a subscription to the location there would hand
    // every consumer a new context value on each navigation — the exact reflow
    // of Traces, Logs and Metrics the provider is written to avoid.
    const screen = useScreen();

    return (
        <div aria-label="Time range" className="time-range" role="group">
            {TIME_RANGE_PRESETS.map((spec) => (
                <button
                    aria-pressed={spec.id === preset}
                    className={`time-range-btn${spec.id === preset ? " active" : ""}`}
                    key={spec.id}
                    onClick={() => {
                        // Whether the default window is the right default, and
                        // which tab makes people reach past it. A picker nobody
                        // touches on Logs and everybody touches on Metrics is a
                        // per-screen default waiting to be set.
                        captureEvent("studio_time_range_changed", { from: preset, preset: spec.id, screen });
                        setPreset(spec.id);
                    }}
                    type="button"
                >
                    {spec.label}
                </button>
            ))}
        </div>
    );
};
