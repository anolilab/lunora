/**
 * Package-manager detection, re-exported from `@lunora/config`.
 *
 * It moved there because `runPostCodegenHook` needs it and that hook has two
 * consumers now — the CLI and `@lunora/vite`'s codegen plugin. This file stays so
 * the ten call sites in the CLI keep importing it by the name they already use;
 * there is one implementation, in `@lunora/config`.
 */
export type { PackageManager, PackageManagerProbe } from "@lunora/config";
export { addArgsFor, detectInstalledManagers, detectPackageManager, execArgsFor, installArgsFor, runScriptArgsFor, runScriptCommand } from "@lunora/config";
