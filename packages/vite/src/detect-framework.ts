/**
 * Meta-framework detection for the Lunora Vite plugin — re-exported from
 * `@lunora/config`, the single source of truth shared with `@lunora/cli` so the
 * dependency-signature table can never drift between the two. See PLAN4 §2.4/§3.
 */
export type { DetectedFramework, FrameworkClass, FrameworkDetection } from "@lunora/config";
export { detectFramework } from "@lunora/config";
