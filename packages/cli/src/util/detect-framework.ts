/**
 * Meta-framework detection for the CLI's in-place init (`lunora init --here`).
 *
 * The detection itself (dependency-signature table → framework + void class) is
 * the shared `detectFramework` from `@lunora/config` — the single source of truth
 * also used by `@lunora/vite`, so the table can never drift. This module only
 * adds the CLI-specific concern on top: the idiomatic Lunora client-adapter
 * package per framework (which `@lunora/vite` has no use for).
 */
import type { DetectedFramework, FrameworkDetection as BaseFrameworkDetection } from "@lunora/config";
import { detectFramework as detectFrameworkBase } from "@lunora/config";

/** The idiomatic Lunora client adapter per detected framework — a CLI-only mapping. */
const ADAPTER_BY_FRAMEWORK: Readonly<Record<DetectedFramework, string>> = {
    astro: "@lunora/react",
    none: "@lunora/react",
    nuxt: "@lunora/vue",
    "react-router": "@lunora/react",
    "solid-start": "@lunora/solid",
    sveltekit: "@lunora/svelte",
    "tanstack-start": "@lunora/react",
    "tanstack-start-solid": "@lunora/solid",
};

/** A {@link BaseFrameworkDetection} plus the client-adapter package the `--here` patcher installs/wires. */
interface FrameworkDetection extends BaseFrameworkDetection {
    /** The idiomatic Lunora client adapter package for this framework (e.g. `@lunora/react`). */
    adapter: string;
}

/**
 * Detect the meta-framework at `root` (via `@lunora/config`) and attach the
 * idiomatic Lunora client adapter for it. Pure and best-effort — never throws;
 * an unknown / missing / malformed `package.json` yields the standalone result
 * (`framework: "none", class: "C", adapter: "@lunora/react"`).
 */
const detectFramework = (root: string): FrameworkDetection => {
    const base = detectFrameworkBase(root);

    return { ...base, adapter: ADAPTER_BY_FRAMEWORK[base.framework] };
};

export type { FrameworkDetection };
export { detectFramework };

export { type DetectedFramework, type FrameworkClass } from "@lunora/config";
