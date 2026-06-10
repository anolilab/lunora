/**
 * Lightweight meta-framework detection for the CLI's in-place init (`cirrus
 * init --here`).
 *
 * This mirrors `@cirrus/vite`'s `detectFramework` (same dependency-name → class
 * table, same void class-A/B/C model — see PLAN4 §3), but is reimplemented here
 * rather than imported because the CLI does not depend on `@cirrus/vite` and we
 * don't want to pull the whole Vite plugin (and its Cloudflare/Rollup deps) into
 * the CLI bundle just to read a `package.json`. Keep the two tables in sync.
 */
import { existsSync, readFileSync } from "node:fs";

import { join } from "@visulima/path";

/**
 * The meta-frameworks the CLI's `--here` patcher knows how to wire, plus
 * `"none"` for a standalone SPA / SSR-less project (the current default).
 */
type DetectedFramework = "astro" | "none" | "nuxt" | "react-router" | "solid-start" | "sveltekit" | "tanstack-start";

/**
 * void's composition class (PLAN4 §3). Class A is Vite-native and Cirrus owns
 * the worker entry. Class B frameworks own their own Cloudflare adapter, so
 * Cirrus injects its worker composition into the framework's server entry. Class
 * C is non-CF / SSR-less — ship the client adapter + a standalone Cirrus worker.
 */
type FrameworkClass = "A" | "B" | "C";

interface FrameworkDetection {
    /** The idiomatic Cirrus client adapter package for this framework (e.g. `@cirrus/react`). */
    adapter: string;
    /** void's composition class for the detected framework. */
    class: FrameworkClass;
    /** The detected meta-framework, or `"none"` when no known one is present. */
    framework: DetectedFramework;
}

/**
 * The dependency-name → framework + class + adapter table. A project declares at
 * most one of these; each entry is matched against the merged `dependencies` and
 * `devDependencies` of the project's `package.json`. Order matters — the first
 * match wins, so the most specific signatures come first.
 */
const FRAMEWORK_SIGNATURES: ReadonlyArray<{ adapter: string; class: FrameworkClass; dependency: string; framework: DetectedFramework }> = [
    { adapter: "@cirrus/react", class: "A", dependency: "@tanstack/react-start", framework: "tanstack-start" },
    { adapter: "@cirrus/react", class: "A", dependency: "@react-router/dev", framework: "react-router" },
    { adapter: "@cirrus/solid", class: "A", dependency: "@solidjs/start", framework: "solid-start" },
    { adapter: "@cirrus/solid", class: "A", dependency: "solid-start", framework: "solid-start" },
    { adapter: "@cirrus/svelte", class: "B", dependency: "@sveltejs/kit", framework: "sveltekit" },
    { adapter: "@cirrus/vue", class: "B", dependency: "nuxt", framework: "nuxt" },
    { adapter: "@cirrus/react", class: "B", dependency: "astro", framework: "astro" },
];

/** The standalone (class-C) result returned when no known framework is present or detection fails. */
const STANDALONE: FrameworkDetection = { adapter: "@cirrus/react", class: "C", framework: "none" };

/** Read and parse the project `package.json`, returning its merged dependency name set (empty on any failure). */
const readDependencyNames = (root: string): ReadonlySet<string> => {
    const packageJsonPath = join(root, "package.json");

    if (!existsSync(packageJsonPath)) {
        return new Set();
    }

    try {
        const raw = readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

        return new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]);
    } catch {
        // A malformed / unreadable package.json must never crash the CLI — fall
        // back to standalone behaviour.
        return new Set();
    }
};

/**
 * Detect which meta-framework a project at `root` uses by inspecting its
 * `package.json` dependencies, and classify it under void's class-A/B/C model.
 *
 * Pure and best-effort: never throws. An unknown / missing / malformed
 * `package.json` yields the standalone result (`framework: "none", class: "C"`).
 */
const detectFramework = (root: string): FrameworkDetection => {
    const dependencies = readDependencyNames(root);

    if (dependencies.size === 0) {
        return STANDALONE;
    }

    for (const signature of FRAMEWORK_SIGNATURES) {
        if (dependencies.has(signature.dependency)) {
            return { adapter: signature.adapter, class: signature.class, framework: signature.framework };
        }
    }

    return STANDALONE;
};

export type { DetectedFramework, FrameworkClass, FrameworkDetection };
export { detectFramework };
