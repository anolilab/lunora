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

/**
 * Classify a 0..1 rate against its warn/crit thresholds.
 *
 * `NaN` reads "ok": callers derive the rate as `errors / calls`, so `0 / 0` means
 * no traffic at all, which is not a breach. Spelled out because it used to fall out
 * of `NaN >= x` being false — the same edge `ratePercent` answers with an em-dash,
 * so the two were handling it by accident and differently.
 *
 * `Infinity` (errors against zero recorded calls) deliberately still breaches: there
 * ARE errors, and the missing denominator is not a reason to call that healthy.
 */
const rateLevel = (rate: number, warn: number, crit: number): SloLevel => {
    if (Number.isNaN(rate)) {
        return "ok";
    }

    if (rate >= crit) {
        return "crit";
    }

    return rate >= warn ? "warn" : "ok";
};

/** Request error rate (fraction 0..1) at which the SLO reads "warn". */
const REQUEST_ERROR_WARN = 0.01;

/** Request error rate at which it reads "crit" — at or above this is breaching. */
const REQUEST_ERROR_CRIT = 0.05;

export type { SloLevel };
export { LEVEL_VARIANT, rateLevel, ratePercent, REQUEST_ERROR_CRIT, REQUEST_ERROR_WARN };
