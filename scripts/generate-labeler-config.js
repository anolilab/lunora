/**
 * This script is used to generate the `.github/labeler.yml` file.
 *
 * Modified copy of https://github.com/TanStack/router/blob/main/scripts/generateLabelerConfig.mjs
 *
 * MIT License
 * Copyright (c) 2021-present Tanner Linsley
 */

import { readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import * as prettier from "prettier";

/**
 * Pairs of package labels and their corresponding paths
 * @typedef {[string, string]} LabelerPair
 */

/**
 * Directories to exclude from package discovery
 */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "__fixtures__", "examples", "__tests__", "__bench__", ".DS_Store"]);

/**
 * Recursively finds all package.json files in the packages directory
 * @param {string} dir - Directory to search
 * @param {string} baseDir - Base directory (packages/)
 * @param {Array<string>} foundPackages - Array to collect found package paths
 */
const findPackages = (dir, baseDir, foundPackages = []) => {
    try {
        const entries = readdirSync(dir);

        for (const entry of entries) {
            // Skip excluded directories
            if (EXCLUDED_DIRS.has(entry)) {
                continue;
            }

            const fullPath = join(dir, entry);
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                // Check if this directory has a package.json
                const packageJsonPath = join(fullPath, "package.json");
                if (existsSync(packageJsonPath)) {
                    // Get relative path from baseDir
                    const relativePath = relative(baseDir, fullPath);
                    foundPackages.push(relativePath);
                }
                // Always recurse to find nested packages (even if this directory is a package)
                findPackages(fullPath, baseDir, foundPackages);
            }
        }
    } catch (error) {
        // Skip directories we can't read
        console.warn(`Warning: Could not read directory ${dir}:`, error.message);
    }

    return foundPackages;
};

/**
 * @returns {Array<LabelerPair>} Pairs of package labels and their corresponding paths
 */
const readPairsFromFs = () => {
    const packagesDir = resolve("packages");

    if (!existsSync(packagesDir)) {
        console.warn("packages directory not found");
        return [];
    }

    // Find all packages recursively
    const packagePaths = findPackages(packagesDir, packagesDir);

    // Count occurrences of each base package name to detect duplicates
    /** @type {Map<string, string[]>} */
    const nameToPathsMap = new Map();
    for (const packagePath of packagePaths) {
        const packageName = basename(packagePath);
        const existing = nameToPathsMap.get(packageName) || [];
        existing.push(packagePath);
        nameToPathsMap.set(packageName, existing);
    }

    /** @type {Array<LabelerPair>} */
    const pairs = packagePaths.map((packagePath) => {
        const packageName = basename(packagePath);
        const paths = nameToPathsMap.get(packageName) || [];

        // If there are duplicates, disambiguate by including the parent package name
        // e.g., "terminal/tui/npm/darwin-arm64" -> "package: tui/darwin-arm64"
        //        "tooling/task-runner/npm/darwin-arm64" -> "package: task-runner/darwin-arm64"
        let label;
        if (paths.length > 1) {
            // Find the parent package: walk up from the npm/ directory
            const parts = packagePath.split("/");
            const npmIndex = parts.lastIndexOf("npm");
            if (npmIndex >= 1) {
                const parentName = parts[npmIndex - 1];
                label = `package: ${parentName}/${packageName}`;
            } else {
                // Fallback: use the full relative path
                label = `package: ${packagePath.replaceAll("/", "-")}`;
            }
        } else {
            label = `package: ${packageName}`;
        }

        const globPath = `packages/${packagePath}/**/*`;
        return [label, globPath];
    });

    // Sort by package name in alphabetical order
    pairs.sort((a, b) => a[0].localeCompare(b[0]));

    return pairs;
};

/**
 * @param {Array<LabelerPair>} pairs
 * @returns {Promise<string>} YAML string for the labeler config
 */
const generateLabelerYaml = async (pairs) => {
    const s = (n = 1) => " ".repeat(n);

    // Convert the pairs into valid yaml
    const formattedPairs = pairs
        .map(([packageLabel, packagePath]) => {
            const result = [`'${packageLabel}':`, `${s(2)}-${s(1)}changed-files:`, `${s(4)}-${s(1)}any-glob-to-any-file:${s(1)}'${packagePath}'`].join("\n");

            return result;
        })
        .join("\n");

    // Get the location of the Prettier config file
    const prettierConfigPath = await prettier.resolveConfigFile();

    if (!prettierConfigPath) {
        throw new Error("No Prettier config file found. Please ensure you have a Prettier config file in your project.");
    }

    console.info("using prettier config file at:", prettierConfigPath);

    // Resolve the Prettier config
    const prettierConfig = await prettier.resolveConfig(prettierConfigPath);
    console.info("using resolved prettier config:", prettierConfig);

    // Format the YAML string using Prettier
    const formattedStr = await prettier.format(formattedPairs, {
        parser: "yaml",
        ...prettierConfig,
    });

    return formattedStr;
};

const run = async () => {
    console.info("Generating labeler config...");

    // Generate the pairs of package labels and their corresponding paths
    const pairs = readPairsFromFs();

    // Always add the docs folder
    pairs.push(["documentation", "docs/**/*"]);

    // Convert the pairs into valid yaml
    const yamlStr = await generateLabelerYaml(pairs);

    // Write to '.github/labeler.yml'
    const configPath = resolve("labeler-config.yml");
    writeFileSync(configPath, yamlStr, {
        encoding: "utf-8",
    });

    console.info(`Generated labeler config at \`${configPath}\`!`);
};

try {
    run().then(() => {
        process.exit(0);
    });
} catch (error) {
    console.error("Error generating labeler config:", error);
    process.exit(1);
}
