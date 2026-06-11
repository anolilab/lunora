/**
 * Meta-framework detection for the CLI's in-place init (`cirrus init --here`).
 *
 * The detection itself (dependency-signature table → framework + void class) is
 * the shared `detectFramework` from `@cirrus/config` — the single source of truth
 * also used by `@cirrus/vite`, so the table can never drift. This module only
 * adds the CLI-specific concern on top: the idiomatic Cirrus client-adapter
 * package per framework (which `@cirrus/vite` has no use for).
 */
import type { DetectedFramework, FrameworkDetection as BaseFrameworkDetection } from "@cirrus/config";
import { detectFramework as detectFrameworkBase } from "@cirrus/config";

/** The idiomatic Cirrus client adapter per detected framework — a CLI-only mapping. */
const ADAPTER_BY_FRAMEWORK: Readonly<Record<DetectedFramework, string>> = {
    astro: "@cirrus/react",
    none: "@cirrus/react",
    nuxt: "@cirrus/vue",
    "react-router": "@cirrus/react",
    "solid-start": "@cirrus/solid",
    sveltekit: "@cirrus/svelte",
    "tanstack-start": "@cirrus/react",
    "tanstack-start-solid": "@cirrus/solid",
};

/** A {@link BaseFrameworkDetection} plus the client-adapter package the `--here` patcher installs/wires. */
interface FrameworkDetection extends BaseFrameworkDetection {
    /** The idiomatic Cirrus client adapter package for this framework (e.g. `@cirrus/react`). */
    adapter: string;
}

/**
 * Detect the meta-framework at `root` (via `@cirrus/config`) and attach the
 * idiomatic Cirrus client adapter for it. Pure and best-effort — never throws;
 * an unknown / missing / malformed `package.json` yields the standalone result
 * (`framework: "none", class: "C", adapter: "@cirrus/react"`).
 */
const detectFramework = (root: string): FrameworkDetection => {
    const base = detectFrameworkBase(root);

    return { ...base, adapter: ADAPTER_BY_FRAMEWORK[base.framework] };
};

export type { FrameworkDetection };
export { detectFramework };

export { type DetectedFramework, type FrameworkClass } from "@cirrus/config";
