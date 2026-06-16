/**
 * Generates an OG SVG for every @lunora/* package from the shared
 * .github/assets/package_og.jpg template (the package name is overlaid as text)
 * and injects it into each package README between the OG placeholder markers.
 *
 * Run directly (`pnpm generate:og`) or automatically on `postinstall`.
 * If the base image is missing it skips gracefully so installs never fail.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");

const SCOPE = "@lunora/";

/**
 * Converts a JPG image to a base64 data URI.
 * @param {string} imagePath - Path to the JPG image
 * @returns {string} Base64 data URI
 */
const imageToBase64 = (imagePath) => `data:image/jpeg;base64,${readFileSync(imagePath).toString("base64")}`;

/**
 * Escapes HTML entities in text.
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/**
 * Capitalizes the first letter of each word.
 * @param {string} text - Text to capitalize
 * @returns {string} Capitalized text
 */
const capitalize = (text) =>
    text
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");

/**
 * Generates an SVG with the package name overlaid on the template image.
 * @param {string} packageName - Package name without the @lunora/ prefix
 * @param {string} imageDataUri - Base64 data URI of the template image
 * @returns {string} SVG string
 */
const generatePackageSVG = (packageName, imageDataUri) => {
    // Image dimensions from the JPG file (1660x512).
    const width = 1660;
    const height = 512;

    const textX = 65;
    const startY = 117;

    const name = packageName
        .replaceAll(/-/g, " ")
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map((word) => capitalize(word.trim()))
        .join(" ");

    const tspanElements = `    <tspan x="${textX}" y="${startY}">${escapeHtml(name)}</tspan>`;

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image href="${imageDataUri}" width="${width}" height="${height}" />
  <text
    font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    font-size="52"
    font-weight="700"
    fill="#ffffff"
    text-anchor="start"
    dominant-baseline="hanging"
    style="text-shadow: 0 2px 8px rgba(0,0,0,0.5), 0 0 2px rgba(0,0,0,0.3);"
  >
${tspanElements}
  </text>
</svg>`;
};

/**
 * Finds all @lunora/* packages under packages/.
 * @returns {Array<{name: string, path: string, packageName: string, description: string}>}
 */
const findPackages = () => {
    const packages = [];
    const packagesDir = resolve(rootDir, "packages");

    const traverseDir = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }

            const fullPath = join(dir, entry.name);
            const packageJsonPath = join(fullPath, "package.json");

            if (existsSync(packageJsonPath)) {
                try {
                    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

                    if (packageJson.name && packageJson.name.startsWith(SCOPE)) {
                        packages.push({
                            name: packageJson.name,
                            path: fullPath,
                            packageName: packageJson.name.replace(SCOPE, ""),
                            description: packageJson.description || "",
                        });
                    }
                } catch (error) {
                    console.warn(`Failed to parse package.json at ${packageJsonPath}:`, error.message);
                }
            } else {
                traverseDir(fullPath);
            }
        }
    };

    traverseDir(packagesDir);

    return packages;
};

/**
 * Saves the SVG into the package's __assets__ folder.
 * @param {string} packagePath - Path to the package directory
 * @param {string} svg - SVG string to save
 * @returns {string} Relative path to the saved SVG file
 */
const saveSVGToAssets = (packagePath, svg) => {
    const assetsDir = join(packagePath, "__assets__");

    if (!existsSync(assetsDir)) {
        mkdirSync(assetsDir, { recursive: true });
    }

    writeFileSync(join(assetsDir, "package-og.svg"), svg, "utf-8");

    return "__assets__/package-og.svg";
};

const START_PLACEHOLDER = "<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->";
const END_PLACEHOLDER = "<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->";

/**
 * Injects the OG image + description between the placeholder markers in a README.
 * @param {string} readmePath - Path to README.md
 * @param {string} svgPath - Relative path to the SVG file
 * @param {string} packageName - Package name without the @lunora/ prefix
 * @param {string} packageDescription - Package description from package.json
 * @returns {boolean} True if the file was updated
 */
const insertSVGIntoReadme = (readmePath, svgPath, packageName, packageDescription) => {
    if (!existsSync(readmePath)) {
        console.warn(`README.md not found at ${readmePath}`);

        return false;
    }

    const content = readFileSync(readmePath, "utf-8");

    const startIndex = content.indexOf(START_PLACEHOLDER);
    const endIndex = content.indexOf(END_PLACEHOLDER);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        console.warn(`Placeholders not found in ${readmePath}. Skipping...`);

        return false;
    }

    const imageLink = `<a href="https://www.anolilab.com/open-source" align="center">\n\n  <img src="${svgPath}" alt="${escapeHtml(packageName)}" />\n\n</a>\n\n<h3 align="center">${escapeHtml(packageDescription)}</h3>`;

    const before = content.slice(0, startIndex);
    const after = content.slice(endIndex + END_PLACEHOLDER.length);
    const next = `${before}${START_PLACEHOLDER}\n\n${imageLink}\n\n${END_PLACEHOLDER}${after}`;

    if (next !== content) {
        writeFileSync(readmePath, next, "utf-8");
    }

    return true;
};

const run = () => {
    const imagePath = resolve(rootDir, ".github", "assets", "package_og.jpg");

    if (!existsSync(imagePath)) {
        console.warn(`OG base image not found at ${imagePath}. Skipping OG generation.`);

        return;
    }

    console.info("Generating package OG images...");

    const imageDataUri = imageToBase64(imagePath);
    const packages = findPackages();

    console.info(`Found ${packages.length} packages`);

    let updated = 0;
    let skipped = 0;

    for (const pkg of packages) {
        const svg = generatePackageSVG(pkg.packageName, imageDataUri);
        const svgPath = saveSVGToAssets(pkg.path, svg);

        if (insertSVGIntoReadme(join(pkg.path, "README.md"), svgPath, pkg.packageName, pkg.description)) {
            updated += 1;
        } else {
            skipped += 1;
        }
    }

    console.info(`\nCompleted! Updated ${updated} README files, skipped ${skipped} files.`);
};

try {
    run();
    process.exit(0);
} catch (error) {
    console.error("Error generating package OG images:", error);
    process.exit(1);
}
