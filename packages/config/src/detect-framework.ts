import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The meta-frameworks Cirrus can compose with, plus `"none"` for a standalone
 * SPA / SSR-less project (the current default). Mirrors PLAN4 §2.4.
 */
type DetectedFramework = "astro" | "none" | "nuxt" | "react-router" | "solid-start" | "sveltekit" | "tanstack-start";

/**
 * void's class model (PLAN4 §3). Class A is Vite-native and Cirrus owns the
 * worker entry (`createWorker({ httpRouter })`). Class B frameworks own their own
 * Cloudflare adapter, so Cirrus injects its worker composition into the
 * framework's server entry via hooks (PLAN4 M4). Class C is non-CF / SSR-less —
 * ship the client adapter + a standalone Cirrus worker (today's default).
 */
type FrameworkClass = "A" | "B" | "C";

interface FrameworkDetection {
    /** void's composition class for the detected framework. */
    class: FrameworkClass;
    /** The detected meta-framework, or `"none"` when no known one is present. */
    framework: DetectedFramework;
}

/**
 * The dependency-name to framework + class table. In practice a project declares
 * at most one of these; each entry is matched against the merged `dependencies`
 * and `devDependencies` of the project's `package.json`. Order matters — the
 * first match wins, so the most specific signatures come first.
 *
 * This is the SINGLE source of truth for framework detection, shared by
 * `@cirrus/vite` (which re-exports it) and `@cirrus/cli` (which wraps it to add
 * the per-framework client-adapter mapping). Both depend on `@cirrus/config`, so
 * the table can never drift between them.
 */
const FRAMEWORK_SIGNATURES: ReadonlyArray<{ class: FrameworkClass; dependency: string; framework: DetectedFramework }> = [
    { class: "A", dependency: "@tanstack/react-start", framework: "tanstack-start" },
    { class: "A", dependency: "@react-router/dev", framework: "react-router" },
    { class: "A", dependency: "@solidjs/start", framework: "solid-start" },
    { class: "A", dependency: "solid-start", framework: "solid-start" },
    { class: "B", dependency: "@sveltejs/kit", framework: "sveltekit" },
    { class: "B", dependency: "nuxt", framework: "nuxt" },
    { class: "B", dependency: "astro", framework: "astro" },
];

/** The standalone (class-C) result returned when no known framework is present or detection fails. */
const STANDALONE: FrameworkDetection = { class: "C", framework: "none" };

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
        // A malformed / unreadable package.json must never crash a consumer —
        // fall back to standalone behaviour.
        return new Set();
    }
};

/**
 * Detect which meta-framework a project uses by inspecting its `package.json`
 * dependencies, and classify it under void's class-A/B/C model (PLAN4 §3).
 *
 * Pure and best-effort: never throws. An unknown / missing / malformed
 * `package.json` yields `{ framework: "none", class: "C" }` so the standalone
 * SPA flow is preserved.
 */
const detectFramework = (root: string): FrameworkDetection => {
    const dependencies = readDependencyNames(root);

    if (dependencies.size === 0) {
        return STANDALONE;
    }

    for (const signature of FRAMEWORK_SIGNATURES) {
        if (dependencies.has(signature.dependency)) {
            return { class: signature.class, framework: signature.framework };
        }
    }

    return STANDALONE;
};

export type { DetectedFramework, FrameworkClass, FrameworkDetection };
export { detectFramework };
