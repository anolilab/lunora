/**
 * Lists all packages in the monorepo and generates a markdown table
 * Updates the README.md file by replacing content between START_TABLE_PLACEHOLDER and END_TABLE_PLACEHOLDER
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const packagesDir = join(__dirname, "..", "packages");
const readmePath = join(__dirname, "..", "README.md");

/**
 * Recursively finds all package.json files in the packages directory
 * @param {string} dir - Directory to search
 * @param {string[]} packages - Array to collect package info
 * @returns {Promise<void>}
 */
const findPackages = async (dir, packages = []) => {
    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            // Skip test fixtures, examples, benchmarks, and test directories
            if (entry.name.startsWith("__") || entry.name === "examples" || entry.name === "__bench__" || entry.name === "__tests__") {
                continue;
            }

            if (entry.isDirectory()) {
                const packageJsonPath = join(fullPath, "package.json");
                try {
                    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
                    const packageJson = JSON.parse(packageJsonContent);
                    const rootDir = join(__dirname, "..");
                    // Get relative path from root, ensuring it starts with packages/
                    let relativePath = fullPath.replace(rootDir, "").replace(/^\/+/, "");
                    // If path doesn't start with packages/, add it
                    if (!relativePath.startsWith("packages/")) {
                        relativePath = `packages/${relativePath}`;
                    }
                    // Extract category from path (e.g., packages/api/api-platform -> api)
                    const pathParts = relativePath.split("/");
                    const category = pathParts.length > 1 ? pathParts[1] : "other";

                    packages.push({
                        name: packageJson.name,
                        version: packageJson.version || "",
                        description: packageJson.description || "",
                        path: relativePath,
                        category: category,
                    });
                } catch {
                    // No package.json, continue searching subdirectories
                    await findPackages(fullPath, packages);
                }
            }
        }
    } catch (error) {
        // Directory doesn't exist or can't be read, skip it
        if (error.code !== "ENOENT") {
            console.error(`Error reading directory ${dir}:`, error.message);
        }
    }
};

/**
 * Escapes markdown table special characters
 * @param {string} text - Text to escape
 * @returns {string}
 */
const escapeMarkdown = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * Generates npm badge URL
 * @param {string} packageName - Package name
 * @returns {string}
 */
const getNpmBadgeUrl = (packageName) => {
    const encodedName = encodeURIComponent(packageName);
    return `https://img.shields.io/npm/v/${encodedName}?style=flat-square&labelColor=292a44&color=663399&label=v`;
};

/**
 * Generates npm package URL
 * @param {string} packageName - Package name
 * @returns {string}
 */
const getNpmPackageUrl = (packageName) => `https://www.npmjs.com/package/${packageName}`;

/**
 * Formats category name for display (e.g., "data-manipulation" -> "Data Manipulation", "api" -> "API")
 * @param {string} category - Category name
 * @returns {string}
 */
const formatCategoryName = (category) => {
    // Special cases for acronyms (check entire category first)
    const categoryAcronyms = {
        api: "API",
    };

    if (categoryAcronyms[category]) {
        return categoryAcronyms[category];
    }

    // Special cases for individual words that are acronyms
    const wordAcronyms = {
        api: "API",
    };

    return category
        .split("-")
        .map((word) => {
            // Check if word is an acronym
            if (wordAcronyms[word.toLowerCase()]) {
                return wordAcronyms[word.toLowerCase()];
            }
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
};

/**
 * Generates the markdown table content grouped by category
 * @param {Object} packagesByCategory - Object with categories as keys and arrays of packages as values
 * @returns {string}
 */
const generateTableContent = (packagesByCategory) => {
    let content = "";

    // Sort categories alphabetically
    const sortedCategories = Object.keys(packagesByCategory).sort();

    for (const category of sortedCategories) {
        const packages = packagesByCategory[category];
        const categoryName = formatCategoryName(category);

        // Add category header
        content += `\n### ${categoryName}\n\n`;
        content += "| Package | Version | Description |\n";
        content +=
            "| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |\n";

        // Sort packages within category by name
        packages.sort((a, b) => a.name.localeCompare(b.name));

        // Add packages for this category
        for (const pkg of packages) {
            const packageLink = `[${pkg.name}](${pkg.path}/README.md)`;
            const npmBadge = `[![npm](https://img.shields.io/npm/v/${encodeURIComponent(pkg.name)}?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/${encodeURIComponent(pkg.name)})`;
            const description = escapeMarkdown(pkg.description || "No description");

            content += `| ${packageLink} | ${npmBadge} | ${description} |\n`;
        }
    }

    return content.trim();
};

/**
 * Replaces content between placeholders in README
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
 * Main function to list all packages and update README
 */
const listPackages = async () => {
    const packages = [];
    await findPackages(packagesDir, packages);

    // Group packages by category
    const packagesByCategory = {};
    for (const pkg of packages) {
        if (!packagesByCategory[pkg.category]) {
            packagesByCategory[pkg.category] = [];
        }
        packagesByCategory[pkg.category].push(pkg);
    }

    // Generate table content grouped by category
    const tableContent = generateTableContent(packagesByCategory);

    // Read current README
    const readmeContent = await readFile(readmePath, "utf-8");

    // Replace content between placeholders
    const updatedReadme = replaceTableContent(readmeContent, tableContent);

    // Write updated README
    await writeFile(readmePath, updatedReadme, "utf-8");

    const totalPackages = packages.length;
    const categoryCount = Object.keys(packagesByCategory).length;
    console.log(`✅ Successfully updated README.md with ${totalPackages} packages across ${categoryCount} categories\n`);
};

listPackages().catch((error) => {
    console.error("Error listing packages:", error);
    process.exit(1);
});
