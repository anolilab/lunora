/**
 * Lists all packages in the monorepo and generates a markdown table.
 * Updates the README.md file by replacing content between START_TABLE_PLACEHOLDER and END_TABLE_PLACEHOLDER.
 *
 * Lunora's packages live flat under `packages/<name>/`, so the category is read from each
 * package's `project.json` `category:<slug>` tag rather than from the directory path.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");
const readmePath = join(rootDir, "README.md");

/**
 * Reads the `category:<slug>` tag from a package's project.json.
 * @param {string} packageDir - Absolute path to the package directory
 * @returns {Promise<string>} The category slug, or "other" if none is declared
 */
const readCategory = async (packageDir) => {
    try {
        const projectJson = JSON.parse(await readFile(join(packageDir, "project.json"), "utf-8"));
        const categoryTag = (projectJson.tags || []).find((tag) => tag.startsWith("category:"));

        return categoryTag ? categoryTag.slice("category:".length) : "other";
    } catch {
        return "other";
    }
};

/**
 * Finds every publishable package directly under `packages/` (one level deep, flat layout).
 * @returns {Promise<Array<{name: string, version: string, description: string, path: string, category: string}>>}
 */
const findPackages = async () => {
    const packages = [];
    const entries = await readdir(packagesDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("__") || entry.name.startsWith(".")) {
            continue;
        }

        const packageDir = join(packagesDir, entry.name);

        let packageJson;
        try {
            packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf-8"));
        } catch {
            // No package.json — not a package, skip.
            continue;
        }

        // Skip private (non-published) packages.
        if (packageJson.private) {
            continue;
        }

        packages.push({
            name: packageJson.name,
            version: packageJson.version || "",
            description: packageJson.description || "",
            path: `packages/${entry.name}`,
            category: await readCategory(packageDir),
        });
    }

    return packages;
};

/**
 * Escapes markdown table special characters.
 * @param {string} text - Text to escape
 * @returns {string}
 */
const escapeMarkdown = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * Human-readable display names for category slugs. Anything not listed is title-cased.
 */
const CATEGORY_NAMES = {
    "add-on": "Add-ons",
    advisor: "Advisor",
    cli: "CLI",
    client: "Client & Framework Adapters",
    codegen: "Codegen",
    "dev-tools": "Dev Tools",
    runtime: "Runtime",
    "vite-plugin": "Vite Plugin",
};

/**
 * Preferred ordering for category sections. Categories not listed are appended alphabetically.
 */
const CATEGORY_ORDER = ["runtime", "client", "cli", "codegen", "vite-plugin", "dev-tools", "advisor", "add-on"];

/**
 * Formats a category slug for display.
 * @param {string} category - Category slug
 * @returns {string}
 */
const formatCategoryName = (category) =>
    CATEGORY_NAMES[category] ||
    category
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

/**
 * Generates the markdown table content grouped by category.
 * @param {Record<string, Array<{name: string, description: string, path: string}>>} packagesByCategory
 * @returns {string}
 */
const generateTableContent = (packagesByCategory) => {
    let content = "";

    const sortedCategories = Object.keys(packagesByCategory).sort((a, b) => {
        const aIndex = CATEGORY_ORDER.indexOf(a);
        const bIndex = CATEGORY_ORDER.indexOf(b);

        if (aIndex !== -1 && bIndex !== -1) {
            return aIndex - bIndex;
        }
        if (aIndex !== -1) {
            return -1;
        }
        if (bIndex !== -1) {
            return 1;
        }

        return a.localeCompare(b);
    });

    for (const category of sortedCategories) {
        const packages = packagesByCategory[category];

        content += `\n### ${formatCategoryName(category)}\n\n`;
        content += "| Package | Version | Description |\n";
        content += "| --- | --- | --- |\n";

        packages.sort((a, b) => a.name.localeCompare(b.name));

        for (const pkg of packages) {
            const packageLink = `[\`${pkg.name}\`](${pkg.path}/README.md)`;
            const encodedName = encodeURIComponent(pkg.name);
            const npmBadge = `[![npm](https://img.shields.io/npm/v/${encodedName}?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/${encodedName})`;
            const description = escapeMarkdown(pkg.description || "No description");

            content += `| ${packageLink} | ${npmBadge} | ${description} |\n`;
        }
    }

    return content.trim();
};

/**
 * Replaces content between placeholders in the README.
 * @param {string} readmeContent - Current README content
 * @param {string} newContent - New content to insert
 * @returns {string}
 */
const replaceTableContent = (readmeContent, newContent) => {
    const startMarker = "<!-- START_TABLE_PLACEHOLDER -->";
    const endMarker = "<!-- END_TABLE_PLACEHOLDER -->";

    const startIndex = readmeContent.indexOf(startMarker);
    const endIndex = readmeContent.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
        throw new Error(`Could not find placeholders in README. Make sure both ${startMarker} and ${endMarker} exist.`);
    }

    if (startIndex >= endIndex) {
        throw new Error("START_TABLE_PLACEHOLDER must come before END_TABLE_PLACEHOLDER");
    }

    const before = readmeContent.substring(0, startIndex + startMarker.length);
    const after = readmeContent.substring(endIndex);

    return `${before}\n${newContent}\n${after}`;
};

/**
 * Main function to list all packages and update the README.
 */
const listPackages = async () => {
    const packages = await findPackages();

    const packagesByCategory = {};
    for (const pkg of packages) {
        (packagesByCategory[pkg.category] ||= []).push(pkg);
    }

    const tableContent = generateTableContent(packagesByCategory);
    const readmeContent = await readFile(readmePath, "utf-8");
    const updatedReadme = replaceTableContent(readmeContent, tableContent);

    await writeFile(readmePath, updatedReadme, "utf-8");

    const categoryCount = Object.keys(packagesByCategory).length;
    console.log(`✅ Successfully updated README.md with ${packages.length} packages across ${categoryCount} categories\n`);
};

listPackages().catch((error) => {
    console.error("Error listing packages:", error);
    process.exit(1);
});
