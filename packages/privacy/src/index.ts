export type { ArchiveFile, Manifest, ManifestDataset, SummaryDataset } from "./archive";
export { buildArchive, buildManifest, buildSummaryPdf, MANIFEST_FORMAT_VERSION } from "./archive";
export type { DataOrigin, ExportArticle, LegalBasis } from "./articles";
export { articlesFor } from "./articles";
export type { AuthTableNames } from "./builtins";
export { actionCacheDataset, authDataset, documentHistoryDataset, storageObjectsDataset } from "./builtins";
export type { CoverageProblem, TableClassification } from "./coverage";
export { checkCoverage } from "./coverage";
export type { Dataset, DatasetPhase, DatasetPlacement, DatasetSpec, TableErasure, TableSpec } from "./dataset";
export { defineDataset, erasureOrder } from "./dataset";

/**
 * `@lunora/privacy`: data-subject rights for Lunora apps. Export (GDPR Art. 15
 * and 20), erasure (Art. 17) and retention holds. This entry holds the pure core;
 * the jurisdiction presets live at `./eu` and `./de`.
 */
export { addCalendarMonths, dueAt, extendedDueAt } from "./deadlines";
export type { Disposition, VerifyResult } from "./erasure";
export { dispositionOf, drainUntilEmpty, ERASE_BATCH, verifyErasure } from "./erasure";
export type { RequestStatus, RequestType } from "./lifecycle";
export {
    canCancel,
    canExtend,
    effectiveDueAt,
    erasureGraceUntil,
    InvalidTransitionError,
    isOverdue,
    isTerminal,
    MIN_DRAIN_BUDGET_DAYS,
    transition,
} from "./lifecycle";
export type { ErasureSettings, RequestRecord, RequestStore } from "./requests";
export { cancelRequest, extendRequest, openRequest } from "./requests";
export type { PrivacyPolicy, PrivacyPreset, RetainDirective, RetentionRule, RetentionStart } from "./rules";
export { retain, retainUntil } from "./rules";
export type { PrivacyTableName } from "./tables";
export { privacyExtension } from "./tables";
export { runErasure, runExport } from "./run";
export type { DataPort, ErasureOutcome, ExportOutcome, RunContext, StorePort } from "./run";
