/**
 * Meta-framework detection for the Cirrus Vite plugin — re-exported from
 * `@cirrus/config`, the single source of truth shared with `@cirrus/cli` so the
 * dependency-signature table can never drift between the two. See PLAN4 §2.4/§3.
 */
export type { DetectedFramework, FrameworkClass, FrameworkDetection } from "@cirrus/config";
export { detectFramework } from "@cirrus/config";
