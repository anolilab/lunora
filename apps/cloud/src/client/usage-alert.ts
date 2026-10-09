/**
 * What the Alerts tab says about a monthly usage rule (`usage_threshold`),
 * kept out of the components so the wording and the arithmetic are tested
 * without a DOM: the meter choices, the suggestion line, the threshold the
 * form submits, and the rule list's month-to-date against its threshold.
 */
import type { UsageAlertMeter, UsageThresholdSuggestion } from "../telemetry/usage-alerts";
import { formatUsageQuantity, SUGGESTION_MULTIPLIER, USAGE_ALERT_METERS, USAGE_METER_LABELS } from "../telemetry/usage-alerts";

/** The meter dropdown, in the order the meters are listed. */
export const USAGE_METER_CHOICES: ReadonlyArray<{ label: string; unit: string; value: UsageAlertMeter }> = USAGE_ALERT_METERS.map((value) => {
    return { label: USAGE_METER_LABELS[value].label, unit: USAGE_METER_LABELS[value].unit, value };
});

/** The month a suggestion's history is of, as "June". */
const monthOf = (periodStart: number): string => new Date(periodStart).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

/** The sentence about a suggestion itself: last month, and why the suggestion is what it is. */
const suggestionText = (suggestion: UsageThresholdSuggestion): string => {
    const floor = `suggested ${formatUsageQuantity(suggestion.suggested)} ${suggestion.unit}, the minimum suggested for this meter`;

    if (suggestion.lastMonth === null) {
        return `No ${suggestion.unit} recorded in ${monthOf(suggestion.periodStart)} — ${floor}.`;
    }

    const last = `Last month (${monthOf(suggestion.periodStart)}): ${formatUsageQuantity(suggestion.lastMonth)} ${suggestion.unit}`;

    return suggestion.basis === "history"
        ? `${last} — suggested ${formatUsageQuantity(suggestion.suggested)}, ${String(SUGGESTION_MULTIPLIER)}× last month.`
        : `${last} — ${floor}.`;
};

/**
 * The line under the threshold: last month, and why the suggestion is what it
 * is. `undefined` while it loads. The history is the organization's: with a
 * project chosen (`scoped`), the line says so, since a project's share of a
 * closed month is not kept.
 */
export const suggestionLine = (suggestion: undefined | UsageThresholdSuggestion, scoped = false): string | undefined => {
    if (suggestion === undefined) {
        return undefined;
    }

    const line = suggestionText(suggestion);

    return scoped ? `${line} Last month is the whole organization's usage.` : line;
};

/**
 * The threshold field's value: what the member typed, else the suggestion once
 * it has loaded. Derived rather than copied into state, so the suggestion
 * arriving never overwrites a number somebody typed.
 */
export const usageThresholdValue = (typed: null | string, suggestion: undefined | UsageThresholdSuggestion): string =>
    typed ?? (suggestion === undefined ? "" : String(suggestion.suggested));

/** A usage rule's condition, as the rule list shows it: "Workers requests ≥ 2,000,000 requests / month". */
export const usageCondition = (meter: UsageAlertMeter, threshold: number): string => {
    const { label, unit } = USAGE_METER_LABELS[meter];

    return `${label} ≥ ${formatUsageQuantity(threshold)} ${unit} / month`;
};

/** A usage rule's month-to-date against its threshold: "1,234,567 this month · 62%". */
export const usageProgressLine = (monthToDate: number, threshold: number): string => {
    const share = threshold > 0 ? Math.floor((monthToDate / threshold) * 100) : 0;

    return `${formatUsageQuantity(Math.round(monthToDate * 100) / 100)} this month · ${String(share)}%`;
};
