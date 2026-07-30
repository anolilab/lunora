/**
 * SLO presentation shared by the health panel and its digest.
 *
 * Its own module so the badge tone for a level and the rendering of a rate stay
 * one decision, rather than a copy in each surface.
 */
type SloLevel = "crit" | "ok" | "warn";

/** Map an SLO level to a Badge variant, so a breach reads red at a glance. */
const LEVEL_VARIANT: Record<SloLevel, "default" | "destructive" | "secondary"> = {
    crit: "destructive",
    ok: "secondary",
    warn: "default",
};

/** A 0..1 rate as a percentage string, or `—` when the denominator is zero (no traffic yet). */
const ratePercent = (numerator: number, denominator: number): string => {
    if (denominator === 0) {
        return "—";
    }

    return `${((numerator / denominator) * 100).toFixed(1)}%`;
};

/** Classify a 0..1 rate against its warn/crit thresholds. */
const rateLevel = (rate: number, warn: number, crit: number): SloLevel => {
    if (rate >= crit) {
        return "crit";
    }

    return rate >= warn ? "warn" : "ok";
};

/** SLO thresholds (fraction 0..1). Below `warn` is healthy; at/above `crit` is breaching. */
const REQUEST_ERROR_WARN = 0.01;

const REQUEST_ERROR_CRIT = 0.05;

export type { SloLevel };
export { LEVEL_VARIANT, rateLevel, ratePercent, REQUEST_ERROR_CRIT, REQUEST_ERROR_WARN };
