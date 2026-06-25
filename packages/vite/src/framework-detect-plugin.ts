import type { Plugin } from "vite";

import type { FrameworkDetection } from "./detect-framework";
import { detectFramework } from "./detect-framework";
import { lunoraLine } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Mutable, plugin-shared context. The `lunora()` factory creates one instance
 * and threads it through every Lunora sub-plugin, so detection runs once and
 * downstream plugins (codegen, composition, the dev hint) read the same result
 * without re-scanning `package.json`. PLAN4 §2.4.
 */
interface LunoraPluginContext {
    /** The detected framework + class, populated during `config` / `configResolved`. `undefined` until detection runs. */
    framework?: FrameworkDetection;
}

/** Create an empty shared context object for one `lunora()` invocation. */
const createPluginContext = (): LunoraPluginContext => {
    return {};
};

/** Human-readable labels for the dev one-liner. */
const FRAMEWORK_LABELS: Record<FrameworkDetection["framework"], string> = {
    astro: "Astro",
    none: "standalone (SPA / SSR-less)",
    nuxt: "Nuxt",
    "react-router": "React Router",
    "solid-start": "SolidStart",
    sveltekit: "SvelteKit",
    "tanstack-start": "TanStack Start",
    "tanstack-start-solid": "TanStack Start (Solid)",
};

/**
 * Build the single dev log line announcing the detected framework + how Lunora
 * will compose with it. Kept pure so it is trivially unit-testable.
 */
const formatFrameworkDetection = (detection: FrameworkDetection): string => {
    const label = FRAMEWORK_LABELS[detection.framework];

    if (detection.framework === "none") {
        return lunoraLine("no meta-framework detected — running standalone.");
    }

    if (detection.class === "B") {
        // Class-B (own CF adapter) composition is hook-injection and lands in a
        // later milestone; we still surface the detection so the dev knows.
        return lunoraLine(`detected ${label} — composition is handled by the framework adapter.`);
    }

    return lunoraLine(`detected ${label} — composing the Lunora worker into one Cloudflare Worker.`);
};

/**
 * Vite plugin that detects the host meta-framework from `package.json` and
 * surfaces the result on the shared plugin context so downstream Lunora plugins
 * (and codegen) can read it. Logs the detection once in dev.
 *
 * Additive and safe: for a class-A framework the existing binding reconcile (the
 * codegen plugin) and wrangler validator still run unchanged; for a class-C
 * ("none") project it is a no-op beyond the log line, preserving today's
 * standalone SPA flow. Class-B is detected + logged only — the full
 * hook-injection composition is a separate milestone (PLAN4 M4).
 */
export const frameworkDetectPlugin = (options: ResolvedLunoraPluginOptions, context: LunoraPluginContext): Plugin => {
    let logged = false;

    const detect = (): void => {
        context.framework ??= detectFramework(options.projectRoot);
    };

    return {
        config() {
            // Run detection as early as possible so any later Lunora hook can
            // read `context.framework`. `config` fires before `configResolved`.
            detect();
        },
        configResolved() {
            detect();
        },
        configureServer() {
            // Announce the detected framework once, dev-only, matching the
            // repo's `[lunora] …` log convention.
            detect();

            if (!logged && context.framework !== undefined) {
                logged = true;
                // eslint-disable-next-line no-console -- dev-only one-line announcement, matches the other lunora plugins.
                console.info(formatFrameworkDetection(context.framework));
            }
        },
        name: "lunora:framework-detect",
    };
};

export type { LunoraPluginContext };
export { createPluginContext, formatFrameworkDetection };
