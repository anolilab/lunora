/**
 * Meta-framework detection (PLAN4 §2.4 / §3). Sniffs the project's
 * `package.json` dependencies to decide which framework Cirrus is being
 * composed into, so the plugin pipeline can pick the right composition
 * strategy (class A/B/C) downstream.
 *
 * This is the standalone, side-effect-free detector — it is intentionally
 * NOT wired into `cirrus()` yet (that is later M2 work). It only reads the
 * filesystem; it never throws on a missing or malformed `package.json`,
 * mirroring `@cirrus/config`'s lenient `readWranglerJsonc` (a bad file parses
 * to `undefined` rather than blowing up the dev server).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

/**
 * The meta-frameworks Cirrus knows how to compose with, plus `"none"` for a
 * plain static/SPA app (no SSR framework detected). `"none"` is the absent
 * case — we use a sentinel string rather than `null` so callers always get a
 * `Framework` and the `class` lookup below is total.
 */
type Framework = "astro" | "none" | "nuxt" | "react-router" | "solid-start" | "sveltekit" | "tanstack-start";

/**
 * void's class model (PLAN4 §3). Class **A** is Vite-native and Cirrus owns the
 * worker entry (TanStack Start, React Router, SolidStart). Class **B** means the
 * framework owns its own CF adapter and Cirrus composes via hook-injection
 * (SvelteKit, Nuxt, Astro). Class **C** is non-CF / SSR-less — ship the client
 * adapter + a standalone Cirrus worker (`"none"`).
 */
type FrameworkClass = "A" | "B" | "C";

/** Result of {@link detectFramework}. */
interface DetectFrameworkResult {
    /** Composition class (PLAN4 §3) implied by {@link DetectFrameworkResult.framework}. */
    class: FrameworkClass;
    /** The detected framework, or `"none"` when no known framework is present. */
    framework: Framework;
}

/**
 * Detection map, ordered. Each entry maps a dependency name to the framework
 * it identifies. The **order is the precedence**: when an app declares more
 * than one framework dependency (e.g. a monorepo root, or a migration in
 * progress), the first match in this list wins. The order follows PLAN4 §2.4's
 * listing — class A first (the frameworks where Cirrus owns the worker, our
 * primary target), then class B. Keep this deterministic so detection is
 * reproducible and testable.
 */
const DETECTION_ORDER: ReadonlyArray<readonly [dependency: string, framework: Framework]> = [
    ["@tanstack/react-start", "tanstack-start"],
    ["@react-router/dev", "react-router"],
    ["@solidjs/start", "solid-start"],
    ["solid-start", "solid-start"],
    ["@sveltejs/kit", "sveltekit"],
    ["nuxt", "nuxt"],
    ["astro", "astro"],
];

/** Frameworks whose composition strategy is class A (Cirrus owns the worker entry). */
const CLASS_A: ReadonlySet<Framework> = new Set<Framework>(["react-router", "solid-start", "tanstack-start"]);
/** Frameworks whose composition strategy is class B (framework owns its CF adapter). */
const CLASS_B: ReadonlySet<Framework> = new Set<Framework>(["astro", "nuxt", "sveltekit"]);

/** Map a detected framework to its PLAN4 §3 composition class. */
const classOf = (framework: Framework): FrameworkClass => {
    if (CLASS_A.has(framework)) {
        return "A";
    }

    if (CLASS_B.has(framework)) {
        return "B";
    }

    return "C";
};

/** The result returned whenever no known framework is detected. */
const NONE_RESULT: DetectFrameworkResult = { class: "C", framework: "none" };

interface PackageJsonLike {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
}

/**
 * Read the `package.json` at `root` and parse it leniently. Returns `undefined` when
 * the file is absent, unreadable, not valid JSON, or does not parse to an
 * object — every "can't tell what framework this is" case collapses to the
 * `"none"` result rather than throwing, so detection never aborts a build.
 */
const readPackageJson = (root: string): PackageJsonLike | undefined => {
    const packageJsonPath = join(root, "package.json");

    if (!existsSync(packageJsonPath)) {
        return undefined;
    }

    let text: string;

    try {
        text = readFileSync(packageJsonPath, "utf8");
    } catch {
        return undefined;
    }

    const parseErrors: ParseError[] = [];
    const value: unknown = parseJsonc(text, parseErrors);

    if (parseErrors.length > 0 || value === null || typeof value !== "object") {
        return undefined;
    }

    return value;
};

/**
 * Detect which meta-framework the app at `root` uses by inspecting its
 * `package.json` `dependencies` + `devDependencies` (both are checked — a
 * framework's Vite/build plugin commonly lives in `devDependencies`).
 *
 * Returns `{ framework, class }`. When no known framework dependency is present
 * — or `package.json` is missing/malformed — returns `{ framework: "none",
 * class: "C" }`. When multiple frameworks coexist, the first match in
 * {@link DETECTION_ORDER} wins (deterministic precedence).
 *
 * Never throws on filesystem or parse errors.
 * @param root Absolute path to the project root containing `package.json`.
 */
const detectFramework = (root: string): DetectFrameworkResult => {
    const packageJson = readPackageJson(root);

    if (packageJson === undefined) {
        return NONE_RESULT;
    }

    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

    for (const [dependency, framework] of DETECTION_ORDER) {
        if (dependency in dependencies) {
            return { class: classOf(framework), framework };
        }
    }

    return NONE_RESULT;
};

export type { DetectFrameworkResult, Framework, FrameworkClass };
export { detectFramework };
