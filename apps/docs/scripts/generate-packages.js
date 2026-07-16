/**
 * Generates apps/docs/src/data/packages.ts from workspace package metadata.
 *
 * Data sources:
 * - project.json: category tag (e.g., "category:runtime")
 * - package.json: name, description, homepage
 * - packages-metadata.json: curated displayName, features, and overrides
 *
 * Lunora packages live flat under `packages/<name>/` (no category sub-folders),
 * scoped `@lunora/*` with the single unscoped `lunora` umbrella.
 *
 * Run: node apps/docs/scripts/generate-packages.js
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATEGORY_COLORS, CATEGORY_TITLES, categorySlugForPackageDir, categoryTitleForSlug, humanizeSlug } from "./package-categories.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "..", "..");

// Category tag slug → display name and display name → accent color both live
// in package-categories.js, shared with copy-package-docs.js so the packages
// index and the docs sidebar cannot drift apart.
const categoryColors = CATEGORY_COLORS;

// Load curated metadata
const metadataPath = join(webRoot, "src", "data", "packages-metadata.json");
const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));

// Derive the docs/showcase slug from an npm name.
// "@lunora/server" → "server"; the unscoped umbrella "lunora" → "lunora".
function slugFromNpmName(npmName) {
    if (npmName.startsWith("@lunora/")) {
        return npmName.slice("@lunora/".length);
    }

    return npmName;
}

// Discover workspace packages by scanning the flat packages/ directory.
// Lunora has no category sub-folders — every package is `packages/<name>/`.
function discoverPackages() {
    const packagesDir = join(repoRoot, "packages");
    const packages = [];

    for (const pkg of readdirSync(packagesDir)) {
        const pkgPath = join(packagesDir, pkg);

        if (!statSync(pkgPath).isDirectory()) {
            continue;
        }

        const packageJsonPath = join(pkgPath, "package.json");

        if (!existsSync(packageJsonPath)) {
            continue;
        }

        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

        // Skip private packages (except those with explicit metadata overrides)
        if (packageJson.private && !metadata[pkg]) {
            continue;
        }

        // Skip packages that are platform-specific bindings
        if (packageJson.name && packageJson.name.includes("-binding-")) {
            continue;
        }

        // Category comes from the project.json `category:*` tag; an unknown
        // slug still surfaces (humanized title) so new categories can't
        // silently drop a package from the index.
        const categorySlug = categorySlugForPackageDir(pkgPath);

        if (!categorySlug) {
            continue; // Skip packages without a category tag
        }

        const category = categoryTitleForSlug(categorySlug);

        const npmName = packageJson.name;
        const slug = slugFromNpmName(npmName);
        const meta = metadata[slug] || {};

        // Derive display name: metadata override > humanize slug
        const displayName = meta.displayName || humanizeSlug(slug);

        // Derive description: metadata override > package.json description
        const description = meta.description || packageJson.description || "";

        // Features from metadata (empty array if not curated yet)
        const features = meta.features || [];

        // Only link to a generated docs page when the package actually ships a
        // docs/ folder (copy-package-docs.js only emits pages for those). Without
        // this guard a docless package (e.g. sql-store) gets a /docs/packages/<slug>
        // link that the docs-site prerender 404s on, failing the build.
        const hasDocs = existsSync(join(pkgPath, "docs"));

        packages.push({
            slug,
            npmName,
            name: displayName,
            description,
            category,
            accentColor: categoryColors[category] || "sky-sapphire",
            ...(hasDocs ? { docsPath: `/docs/packages/${slug}` } : {}),
            features,
        });
    }

    return packages;
}

// Add external packages from metadata (not in the monorepo, like packem)
function addExternalPackages(packages) {
    const discoveredSlugs = new Set(packages.map((p) => p.slug));

    for (const [slug, meta] of Object.entries(metadata)) {
        if (discoveredSlugs.has(slug)) {
            continue;
        }

        // External packages must have full metadata including category and npmName
        if (!meta.category || !meta.npmName) {
            continue;
        }

        packages.push({
            slug,
            npmName: meta.npmName,
            name: meta.displayName || humanizeSlug(slug),
            description: meta.description || "",
            category: meta.category,
            accentColor: categoryColors[meta.category] || "sky-sapphire",
            docsPath: `/docs/packages/${slug}`,
            features: meta.features || [],
        });
    }
}

// Sort packages: by category order, then alphabetically within category
function sortPackages(packages) {
    const categoryOrder = Object.values(CATEGORY_TITLES);

    return packages.sort((a, b) => {
        const catA = categoryOrder.indexOf(a.category);
        const catB = categoryOrder.indexOf(b.category);

        if (catA !== catB) {
            return catA - catB;
        }

        return a.name.localeCompare(b.name);
    });
}

// Generate TypeScript output
function generateTypeScript(packages) {
    const categories = [...new Set(packages.map((p) => p.category))].sort();

    const output = `// Auto-generated by scripts/generate-packages.js — do not edit manually
// To update: node scripts/generate-packages.js
// Curated metadata lives in packages-metadata.json

export type AccentColor = "sky-sapphire" | "crimson-energy" | "royal-amethyst";

export interface PackageInfo {
    accentColor: AccentColor;
    category: string;
    description: string;
    docsPath?: string;
    features: string[];
    name: string;
    npmName: string;
    slug: string;
}

export const categories = [
    "All",
${categories.map((c) => `    ${JSON.stringify(c)},`).join("\n")}
] as const;

export type Category = (typeof categories)[number];

const categoryColors: Record<string, AccentColor> = ${JSON.stringify(categoryColors, null, 4)};

export const packages: PackageInfo[] = [
${packages
    .map(
        (p) => `    {
        accentColor: categoryColors[${JSON.stringify(p.category)}]!,
        category: ${JSON.stringify(p.category)},
        description: ${JSON.stringify(p.description)},${p.docsPath ? `\n        docsPath: ${JSON.stringify(p.docsPath)},` : ""}
        features: ${JSON.stringify(p.features)},
        name: ${JSON.stringify(p.name)},
        npmName: ${JSON.stringify(p.npmName)},
        slug: ${JSON.stringify(p.slug)},
    },`,
    )
    .join("\n")}
];

export function getPackageBySlug(slug: string): PackageInfo | undefined {
    return packages.find((p) => p.slug === slug);
}

export function getPackagesByCategory(category: string): PackageInfo[] {
    if (category === "All") {
        return packages;
    }

    return packages.filter((p) => p.category === category);
}
`;

    return output;
}

// Main
const packages = discoverPackages();
addExternalPackages(packages);
const sorted = sortPackages(packages);

const outputPath = join(webRoot, "src", "data", "packages.ts");
writeFileSync(outputPath, generateTypeScript(sorted));

console.log(`Generated ${outputPath} with ${sorted.length} packages`);

// Show packages without features (need curation)
const uncurated = sorted.filter((p) => p.features.length === 0);

if (uncurated.length > 0) {
    console.log(`\nPackages missing features in packages-metadata.json:`);
    uncurated.forEach((p) => console.log(`  - ${p.slug}`));
}
