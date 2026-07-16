/**
 * Single source of truth for the docs site's package categories.
 *
 * Membership is NOT declared here — it is derived from each package's
 * `project.json` `category:<slug>` tag (see `categorySlugForPackageDir`), so a
 * package with a `docs/` folder can never be orphaned from the sidebar again.
 * This module only maps category slugs to display titles (in sidebar order)
 * and accent colors, plus optional per-category ordering hints.
 *
 * Used by both `generate-packages.js` (packages index) and
 * `copy-package-docs.js` (sidebar meta.json) so the two can't drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Category slug → display title, in sidebar order. A slug missing here still
 * surfaces — it falls back to a humanized title after the known categories.
 */
export const CATEGORY_TITLES = {
    runtime: "Core Runtime",
    client: "Client & UI",
    "vite-plugin": "Build & Tooling",
    codegen: "Codegen",
    cli: "CLI",
    "dev-tools": "Dev Tools",
    advisor: "Advisor",
    "add-on": "Add-ons",
    web3: "Web3",
};

/** Category display title → accent color for the packages index cards. */
export const CATEGORY_COLORS = {
    "Core Runtime": "sky-sapphire",
    "Client & UI": "royal-amethyst",
    "Build & Tooling": "sky-sapphire",
    Codegen: "crimson-energy",
    CLI: "royal-amethyst",
    "Dev Tools": "sky-sapphire",
    Advisor: "crimson-energy",
    "Add-ons": "crimson-energy",
    Web3: "crimson-energy",
};

/**
 * Optional curated ordering *within* a category's sidebar section. Purely a
 * sort hint: packages listed here come first (in this order); anything not
 * listed follows alphabetically — so a missing entry can't hide a package.
 */
export const CATEGORY_ORDER_HINTS = {
    "add-on": ["auth", "mail", "storage", "scheduler", "queue", "container", "agent", "ai"],
    client: ["client", "react", "react-native", "vue", "solid", "svelte", "angular", "nuxt", "db", "studio"],
    runtime: ["lunorash", "server", "values", "runtime", "do", "d1"],
};

/**
 * Humanize a slug into a fallback display title ("dev-tools" → "Dev Tools").
 * @param slug
 */
export function humanizeSlug(slug) {
    return slug
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** Display title for a category slug, falling back to the humanized slug. */
export function categoryTitleForSlug(categorySlug) {
    return CATEGORY_TITLES[categorySlug] || humanizeSlug(categorySlug);
}

/**
 * Read a package directory's `category:<slug>` tag from its `project.json`.
 * Returns `null` when the file or tag is missing.
 * @param packageDir absolute path to `packages/<name>/`
 */
export function categorySlugForPackageDir(packageDir) {
    const projectJsonPath = join(packageDir, "project.json");

    if (!existsSync(projectJsonPath)) {
        return null;
    }

    try {
        const projectJson = JSON.parse(readFileSync(projectJsonPath, "utf8"));
        const categoryTag = (projectJson.tags || []).find((tag) => typeof tag === "string" && tag.startsWith("category:"));

        return categoryTag ? categoryTag.replace("category:", "") : null;
    } catch {
        return null;
    }
}

/**
 * Order a category's package slugs: curated hints first (in hint order), the
 * rest alphabetically.
 * @param categorySlug
 * @param slugs
 */
export function orderPackagesInCategory(categorySlug, slugs) {
    const hints = CATEGORY_ORDER_HINTS[categorySlug] || [];
    const hinted = hints.filter((slug) => slugs.includes(slug));
    const rest = slugs.filter((slug) => !hinted.includes(slug)).sort((a, b) => a.localeCompare(b));

    return [...hinted, ...rest];
}
