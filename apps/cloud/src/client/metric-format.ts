/**
 * Compact number formatting shared by the Metrics tab and the custom-dashboard
 * metric/stat panels — the headline last-value display (`1.2k`, `3.4M`). Pure, so
 * it unit-tests under the node vitest env and both renderers format identically.
 */

/** Compact number format for a headline value (`1.2k`, `3.4M`, `42`, `3.14`). */
export const formatValue = (value: number): string => {
    const abs = Math.abs(value);

    if (abs >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }

    if (abs >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }

    return Number.isInteger(value) ? String(value) : value.toFixed(2);
};
