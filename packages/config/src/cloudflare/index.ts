/**
 * `@lunora/config/cloudflare` — the wrangler layer.
 *
 * Everything here speaks `wrangler.jsonc`: validating it, reconciling inferred
 * bindings/crons/compatibility-date into it, resolving remote bindings, and the
 * `DeployDriver` that ties them together for `--target cloudflare`.
 *
 * Split out from the package root so `@lunora/config` itself stays
 * provider-neutral. The root keeps what any target needs — the `DeployDriver`
 * contract, the driver registry, project config and target resolution,
 * `.dev.vars` grammar, binding *inference* — while emission and validation,
 * which are wrangler-shaped by definition, live behind this subpath.
 * Plan 114 §5.3 (D6): a package carrying real provider code isolates it behind a
 * subpath rather than relocating wholesale.
 */

export { applyModify } from "../jsonc-edit";
export type { AssertWranglerOptions } from "./assert-wrangler";
export { assertWranglerSatisfiesSchema } from "./assert-wrangler";
export type { BindingManifest, BindingRequirement, ManifestConfigShape } from "./binding-manifest";
export { BINDING_MANIFEST_VERSION, buildBindingManifest } from "./binding-manifest";
export { default as CLOUDFLARE_DRIVER } from "./cloudflare-driver";
export { default as GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG } from "./compatibility-flags";
export type { ExportGap, ReconcileBindingsResult } from "./reconcile-bindings";
export { collectExportGaps, reconcileWranglerBindings } from "./reconcile-bindings";
export type { ReconcileCompatibilityDateResult } from "./reconcile-compatibility-date";
export { reconcileWranglerCompatibilityDate } from "./reconcile-compatibility-date";
export type { ReconcileResult as ReconcileCronsResult } from "./reconcile-crons";
export { describePreservedCrons, reconcileWranglerCrons } from "./reconcile-crons";
export type { ReconcileProject } from "./reconcile-project";
export { reconcileBindingsSafely, reconcileWranglerExtras } from "./reconcile-project";
export type { MaterializeOptions, MaterializeResult, RemoteBindingPlan, RemoteEnableInputs, RemoteWranglerShape } from "./remote-bindings";
export {
    injectRemoteFlags,
    isRemoteEnvEnabled,
    materializeRemoteWranglerConfig,
    planRemoteBindings,
    REMOTE_ELIGIBLE_KEYS,
    resolveRemoteEnabled,
} from "./remote-bindings";
export type { ServiceDevConfigs } from "./service-dev-config";
export { materializeServiceDevConfigs } from "./service-dev-config";
export { withTailConsumer } from "./validate-settings";
export type { WranglerCacheShape } from "./workers-cache";
export { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "./workers-cache";
export type {
    TailConsumer,
    WranglerConfig,
    WranglerContainerEntry,
    WranglerObservability,
    WranglerObservabilityLogs,
    WranglerObservabilityTraces,
    WranglerValidationReport,
    WranglerWorkflowEntry,
} from "./wrangler-config";
export type { WranglerEnvironmentMerge } from "./wrangler-environment";
export { mergeWranglerEnvironment } from "./wrangler-environment";
export type { ReadWranglerResult } from "./wrangler-path";
export { findWranglerFile, readWranglerJsonc, WRANGLER_FILES } from "./wrangler-path";
export type { WranglerProjectValidationOptions, WranglerProjectValidationResult } from "./wrangler-project";
export { UNEXPORTED_CLASS_MARKER, validateWranglerProject } from "./wrangler-project";
export { collectWranglerSecretVariables, scanWranglerVariablesForSecrets } from "./wrangler-secret-variables";
export type { AlchemyTranslation, WranglerConfigShape } from "./wrangler-to-alchemy";
export { wranglerToAlchemy } from "./wrangler-to-alchemy";
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWrangler, validateWranglerConfig } from "./wrangler-validator";
