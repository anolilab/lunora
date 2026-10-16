/**
 * `@lunora/config/cli` — the string, manifest, and package-manager helpers that
 * callers reach for on a hot path (the CLI's every invocation, the bundler
 * plugins' load). It does not import `@lunora/codegen` or `ts-morph`, so loading
 * it costs what the helpers cost, not the whole schema toolchain. The root
 * `@lunora/config` barrel re-exports the same names.
 */
export { AGENT_RULES_HINT, claimAgentRulesHint, detectAgentRules } from "../agent-rules";
export { DEFAULT_DEPLOY_TARGET, deployTargetIds, isRunnableTarget, runnableTargetIds } from "../driver-registry";
export { LUNORA_TAG, lunoraLine } from "../log-line";
export { default as LunoraReporter } from "../lunora-reporter";
export type { PackageManager, PackageManagerProbe } from "../package-manager";
export {
    addArgsFor,
    detectInstalledManagers,
    detectPackageManager,
    execArgsFor,
    installArgsFor,
    runScriptCommand,
    toolchainExecArgs,
} from "../package-manager";
export { readProjectManifest } from "../project-manifest";
export type { StepBadgeName } from "../tui-theme";
export { STEP_BADGE_NAMES } from "../tui-theme";
