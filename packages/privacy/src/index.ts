export type { DataOrigin, ExportArticle, LegalBasis } from "./articles";
export { articlesFor } from "./articles";
export type { CoverageProblem, TableClassification } from "./coverage";
export { checkCoverage } from "./coverage";

/**
 * `@lunora/privacy`: data-subject rights for Lunora apps. Export (GDPR Art. 15
 * and 20), erasure (Art. 17) and retention holds. This entry holds the pure core;
 * the jurisdiction presets live at `./eu` and `./de`.
 */
export { addCalendarMonths, dueAt, extendedDueAt } from "./deadlines";
export type { PrivacyPolicy, PrivacyPreset, RetainDirective, RetentionRule, RetentionStart } from "./rules";
export { retain, retainUntil } from "./rules";
