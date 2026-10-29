export type { CoverageProblem } from "../../../shared/privacy-coverage";
export type { DataOrigin, LegalBasis } from "./articles";

/**
 * `@lunora/privacy`: data-subject rights for Lunora apps. Export (GDPR Art. 15
 * and 20), erasure (Art. 17) and retention holds. This entry holds the pure core;
 * the jurisdiction presets live at `./eu` and `./de`.
 *
 * The surface is what an app calls or annotates: the datasets, the bound API, the
 * ports it implements and the retention directives. The services behind them stay
 * internal, so the app reaches them through `definePrivacy`.
 */
export type { AuthTableNames } from "./builtins";
export { actionCacheDataset, authDataset, documentHistoryDataset, storageObjectsDataset } from "./builtins";
export type { Dataset, DatasetPhase, DatasetPlacement, DatasetSpec, TableErasure, TableSpec } from "./dataset";
export { defineDataset } from "./dataset";
export type {
    ErasureOptions,
    Privacy,
    PrivacyConfig,
    PrivacyFor,
    PrivacyIdentity,
    PrivacyPorts,
    PrivacyWorkflowContext,
    RetryResult,
    SweepResult,
} from "./define";
export { definePrivacy } from "./define";
export type { Disposition, RowDisposition } from "./erasure";
export { dispositionFor, ERASE_BATCH } from "./erasure";
export type { RequestStatus, RequestType } from "./lifecycle";
export { isTerminal, OPEN_STATUSES } from "./lifecycle";
export type { ArchivePort, DataPort, StorePort } from "./ports";
export type { RequestRecord, RequestStore } from "./requests";
export type { RequestRow } from "./rows";
export { fromRequestRow, toRequestPatch, toRequestRow } from "./rows";
export type { PrivacyPolicy, PrivacyPreset, RetainDirective, RetentionRule, RetentionStart } from "./rules";
export { retain } from "./rules";
export type { ErasureOutcome, ExportOutcome } from "./run";
export { archiveBlocked } from "./run";
export { default as privacyExtension } from "./tables";
export type { TombstonePort } from "./tombstones";
