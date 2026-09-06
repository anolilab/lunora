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

export type { BindingManifest, BindingRequirement, ManifestConfigShape } from "./binding-manifest";
export { BINDING_MANIFEST_VERSION, buildBindingManifest } from "./binding-manifest";
export { default as CLOUDFLARE_DRIVER } from "./cloudflare-driver";
export type { ExportGap, ReconcileBindingsResult } from "./reconcile-bindings";
export { collectExportGaps, reconcileWranglerBindings } from "./reconcile-bindings";
export type { ReconcileCompatibilityDateResult } from "./reconcile-compatibility-date";
export { reconcileWranglerCompatibilityDate } from "./reconcile-compatibility-date";
export type { ReconcileResult as ReconcileCronsResult } from "./reconcile-crons";
export { describePreservedCrons, reconcileWranglerCrons } from "./reconcile-crons";
export type { MaterializeOptions, MaterializeResult, RemoteBindingPlan, RemoteEnableInputs, RemoteWranglerShape } from "./remote-bindings";
export {
    injectRemoteFlags,
    isRemoteEnvEnabled,
    materializeRemoteWranglerConfig,
    planRemoteBindings,
    REMOTE_ELIGIBLE_KEYS,
    resolveRemoteEnabled,
} from "./remote-bindings";
export type { WranglerCacheShape } from "./workers-cache";
export { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "./workers-cache";
export type { ReadWranglerResult } from "./wrangler-path";
export { findWranglerFile, readWranglerJsonc, WRANGLER_FILES } from "./wrangler-path";
export { collectWranglerSecretVariables, scanWranglerVariablesForSecrets } from "./wrangler-secret-variables";
export type { AlchemyTranslation, WranglerConfigShape } from "./wrangler-to-alchemy";
export { wranglerToAlchemy } from "./wrangler-to-alchemy";
export type {
    TailConsumer,
    WranglerConfig,
    WranglerContainerEntry,
    WranglerEnvironmentMerge,
    WranglerProjectValidationOptions,
    WranglerProjectValidationResult,
    WranglerValidationReport,
    WranglerWorkflowEntry,
} from "./wrangler-validator";
export {
    mergeWranglerEnvironment,
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWrangler,
    validateWranglerConfig,
    validateWranglerProject,
    withTailConsumer,
} from "./wrangler-validator";
