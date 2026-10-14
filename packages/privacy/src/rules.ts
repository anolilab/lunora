/**
 * Retention rules: a named statutory period, its legal citation, and where the
 * period starts. A rule carries `reviewRequired` until a lawyer or tax adviser has
 * signed it off, and the package reports every pending rule (see the `/de` preset).
 */
import { addCalendarMonths } from "./deadlines";

/** Where a retention period starts. `endOfCalendarYear` is the HGB §257 / AO §147 reading. */
export type RetentionStart = "endOfCalendarYear" | "from";

/** A named retention period. */
export interface RetentionRule {
    /** The statute or regulation the period comes from. */
    readonly citation: string;
    /** Stable id, `preset.name`, referenced by `retain(ruleId, …)`. */
    readonly id: string;
    /** What is still open about the rule, when something is. */
    readonly note?: string;
    /** `true` until the rule has been reviewed by counsel or a tax adviser. */
    readonly reviewRequired: boolean;
    /** When the period starts. */
    readonly start: RetentionStart;
    /** ISO date of the last review, when there has been one. */
    readonly verifiedAt?: string;
    /** Whole years the record must be kept. */
    readonly years: number;
}

/** The response-time policy an app runs under. Each value carries its own review status. */
export interface PrivacyPolicy {
    /** Days between an accepted erasure request and the start of erasure. Capped before the deadline. */
    readonly erasureGraceDays: number;
    /** Art. 12(3) sentence 2: further months when the response is extended. */
    readonly extensionMonths: number;
    /** Art. 12(3): months from receipt to the response. */
    readonly responseMonths: number;
    /** `true` until counsel has reviewed the value. */
    readonly reviewRequired: boolean;
}

/** A jurisdiction preset: the policy it sets and the retention rules it names. */
export interface PrivacyPreset {
    readonly id: "de" | "eu";
    readonly policy?: Partial<PrivacyPolicy>;
    readonly retention: ReadonlyArray<RetentionRule>;
}

/** A table's erasure outcome that keeps the rows for a named rule. */
export interface RetainDirective {
    /** The column whose date starts the period, when the rule starts `from` a date. */
    readonly from?: string;
    readonly kind: "retain";
    readonly rule: string;
}

/** Erase the rows of a table that a rule would otherwise keep. */
export const retain = (rule: string, options: { from?: string } = {}): RetainDirective => {
    return {
        kind: "retain",
        rule,
        ...(options.from === undefined ? {} : { from: options.from }),
    };
};

/** The presets' retention rules by id. A later preset's rule replaces an earlier one with the same id. */
export const retentionRulesOf = (presets: ReadonlyArray<PrivacyPreset>): ReadonlyMap<string, RetentionRule> =>
    new Map(presets.flatMap((preset) => preset.retention).map((rule) => [rule.id, rule] as const));

/**
 * The instant until which a record must be kept. For `endOfCalendarYear` the
 * period runs to 31 December of the year of `from`, plus the years. Erasure may
 * run from the following day.
 */
export const retainUntil = (rule: RetentionRule, from: Date): Date => {
    if (rule.start === "endOfCalendarYear") {
        return new Date(Date.UTC(from.getUTCFullYear() + rule.years, 11, 31, 23, 59, 59, 999));
    }

    return addCalendarMonths(from, rule.years * 12);
};
