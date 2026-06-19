#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");
const DEST_DIR = path.join(__dirname, "..", "src", "content", "docs", "packages");
const PUBLIC_ASSETS_DIR = path.join(__dirname, "..", "public", "assets");

/** Known app routes that should not be rewritten or stripped by the docs link processor. */
const KNOWN_ROUTES = new Set(["changelog", "code-of-conduct", "docs", "imprint", "packages", "privacy"]);
const KNOWN_ROUTES_PATTERN = [...KNOWN_ROUTES].join("|");

/**
 * External repos whose docs/ folder should be fetched and merged into the packages docs.
 * Lunora keeps all its docs in-repo, so there are none.
 */
const EXTERNAL_DOCS = [];

/**
 * Category display names and order for the packages sidebar.
 * Mirrors the `category:*` tags on each package's project.json.
 */
const CATEGORY_CONFIG = {
    runtime: {
        title: "Core Runtime",
        packages: ["lunora", "server", "values", "runtime", "do", "d1"],
    },
    client: {
        title: "Client & UI",
        packages: ["client", "react", "vue", "solid", "svelte", "db", "studio"],
    },
    "vite-plugin": { title: "Build & Tooling", packages: ["vite", "astro"] },
    codegen: { title: "Codegen", packages: ["codegen"] },
    cli: { title: "CLI", packages: ["cli"] },
    "dev-tools": { title: "Dev Tools", packages: ["config", "testing"] },
    advisor: { title: "Advisor", packages: ["advisor"] },
    "add-on": {
        title: "Add-ons",
        packages: [
            "auth",
            "mail",
            "storage",
            "scheduler",
            "container",
            "ai",
            "vectors",
            "ratelimit",
            "mcp",
            "hyperdrive",
            "payment",
            "kv",
            "images",
            "analytics",
            "browser",
            "seed",
            "workflow",
        ],
    },
};

/**
 * Sanitizes meta.json pages array for fumadocs compatibility.
 * Converts object entries (e.g. { title: "Section", pages: [...] }) into
 * fumadocs-native separator + folder reference format.
 */
async function sanitizeMetaJson(filePath) {
    const content = await fs.readFile(filePath, "utf-8");
    const meta = JSON.parse(content);

    if (Array.isArray(meta.pages)) {
        const newPages = [];

        for (const entry of meta.pages) {
            if (typeof entry === "string") {
                newPages.push(entry);
            } else if (typeof entry === "object" && entry !== null && entry.title) {
                // Convert { title: "Section", pages: [...] } to separator + folder reference
                newPages.push(`---${entry.title}---`);

                if (Array.isArray(entry.pages)) {
                    // Extract the folder name from the first page path (e.g., "concepts/log-levels" -> "concepts")
                    const folders = new Set();

                    for (const page of entry.pages) {
                        const parts = page.split("/");

                        if (parts.length > 1) {
                            folders.add(parts[0]);
                        } else {
                            newPages.push(page);
                        }
                    }

                    for (const folder of folders) {
                        newPages.push(folder);
                    }
                }
            }
        }

        meta.pages = newPages;
    }

    await fs.writeFile(filePath, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Ensures MDX files have valid frontmatter with a title
 * and performs compatibility fixes for fumadocs.
 */
async function sanitizeMdx(filePath) {
    let content = await fs.readFile(filePath, "utf-8");

    // 1. Strip relative component/utility imports (e.g., from external repo docs)
    content = content.replace(/^import\s+.*from\s+['"]\.\.?\/(?:components|utils)\/.*['"];?\s*$/gm, "");

    // 2. Replace unsupported code block languages with supported alternatives
    content = content.replace(/^```env$/gm, "```bash");
    content = content.replace(/^```npm$/gm, "```bash");

    // 3. Strip corrupted LLM artifacts (fullwidth pipe characters, tool call markers)
    content = content.replace(/<｜[^｜]*｜>/g, "");

    // 4. Escape ALL angle brackets outside code blocks that aren't standard HTML tags.
    // This prevents MDX from interpreting TypeScript generics, comparison operators,
    // and other non-HTML angle brackets as JSX.
    const codeBlockRegex = /(```[\s\S]*?```|`[^`]+`)/g;
    const parts = content.split(codeBlockRegex);

    const fumadocsComponents =
        "Callout|Tab|Tabs|Cards|Card|Steps|Step|Files|Folder|File|DocsCategory|CodeBlockTabs|CodeBlockTabsList|CodeBlockTabsTrigger|CodeBlockTab|Accordions|Accordion|TypeTable|AutoTypeTable|ImageZoom";
    const safeHtmlTags = `div|span|a|p|ul|ol|li|h[1-6]|br|hr|img|code|pre|em|strong|b|i|u|table|thead|tbody|tfoot|tr|td|th|details|summary|blockquote|section|nav|footer|header|main|aside|figure|figcaption|dl|dt|dd|sup|sub|del|ins|mark|small|abbr|cite|dfn|kbd|samp|var|wbr|!--|${fumadocsComponents}`;
    const safeTagRegex = new RegExp(`<(?!\\/?(?:${safeHtmlTags})[\\s>/])`, "g");

    content = parts
        .map((part, i) => {
            if (i % 2 === 1) {
                return part;
            } // code block - don't modify
            // Escape non-HTML angle brackets
            let result = part.replace(safeTagRegex, "\\<");
            // Strip .mdx/.md extensions from markdown links (they break URL routing)
            result = result.replace(/(\[[^\]]*\]\([^)]*?)\.mdx(\))/g, "$1$2");
            result = result.replace(/(\[[^\]]*\]\([^)]*?)\.md(\))/g, "$1$2");
            return result;
        })
        .join("");

    // 5. Quote frontmatter values containing YAML special characters (@, :, #, etc.)
    if (content.startsWith("---")) {
        const fmEnd = content.indexOf("---", 3);

        if (fmEnd !== -1) {
            const frontmatter = content.substring(3, fmEnd);
            const fixedFm = frontmatter.replace(/^(\w[\w-]*):\s+(?!["'|>])(.+)$/gm, (match, key, value) => {
                if (/[@:#{}[\],&*?|><!%`]/.test(value)) {
                    const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

                    return `${key}: "${escapedValue}"`;
                }
                return match;
            });
            content = `---${fixedFm}---${content.substring(fmEnd + 3)}`;
        }
    }

    // 6. Add frontmatter if missing
    if (!content.startsWith("---")) {
        const basename = path.basename(filePath, path.extname(filePath));
        const title = basename.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

        content = `---\ntitle: "${title}"\n---\n\n` + content;
    }

    await fs.writeFile(filePath, content);
}

/**
 * Recursively copies a directory.
 */
async function copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);

            if (entry.name === "meta.json") {
                await sanitizeMetaJson(destPath);
            } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
                await sanitizeMdx(destPath);
            }
        }
    }
}

/**
 * Determines the branch to use for external repos based on the current git branch.
 */
function getCurrentBranch() {
    try {
        return execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
    } catch {
        return "main";
    }
}

/**
 * Fetches docs from an external GitHub repository via a shallow git clone.
 */
async function fetchExternalDocs({ repo, branches, docsPath, destName }) {
    const currentBranch = getCurrentBranch();
    const targetBranch = branches[currentBranch] || branches.default;

    console.log(`  Fetching ${repo} docs (branch: ${targetBranch})...`);

    const tmpDir = path.join(__dirname, "..", ".tmp-external-docs");
    await fs.rm(tmpDir, { recursive: true, force: true });

    const repoUrl = `https://github.com/${repo}.git`;
    execFileSync("git", ["clone", "--depth", "1", "--branch", targetBranch, repoUrl, tmpDir], { stdio: "pipe" });

    const srcDocsPath = path.join(tmpDir, docsPath);

    try {
        const stat = await fs.stat(srcDocsPath);

        if (!stat.isDirectory()) {
            throw new Error(`${docsPath} is not a directory in ${repo}`);
        }
    } catch (err) {
        if (err.code === "ENOENT") {
            console.warn(`  Warning: ${docsPath}/ not found in ${repo}@${targetBranch}, skipping`);
            await fs.rm(tmpDir, { recursive: true, force: true });
            return false;
        }
        throw err;
    }

    // Remove navigation.json (we generate our own meta.json)
    await fs.rm(path.join(srcDocsPath, "navigation.json"), { force: true });

    const destPath = path.join(DEST_DIR, destName);
    await copyDirectory(srcDocsPath, destPath);

    // Rewrite absolute /docs/ links to include the package prefix
    await rewriteDocsLinks(destPath, destName);

    console.log(`  ${repo}/${docsPath} (${targetBranch}) → packages/${destName}`);

    await fs.rm(tmpDir, { recursive: true, force: true });
    return true;
}

/**
 * After all docs are copied, validate internal /docs/ links and convert
 * broken links to plain text (keeping the label, removing the link).
 */
async function fixBrokenDocsLinks(dir, contentRoot) {
    contentRoot = contentRoot || path.join(dir, "..");
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            await fixBrokenDocsLinks(fullPath, contentRoot);
        } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
            let content = await fs.readFile(fullPath, "utf-8");
            let changed = false;

            // Fix broken markdown-style /docs/ links
            const updated = content.replace(/\[([^\]]*)\]\(\/docs\/(.*?)\)/g, (match, label, docPath) => {
                // Strip hash fragments and trailing slashes for resolution
                const cleanPath = docPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(contentRoot, cleanPath);

                // Check if the target exists as a file or directory with index
                const exists =
                    existsSync(resolved + ".mdx") ||
                    existsSync(resolved + ".md") ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"));

                if (!exists) {
                    changed = true;
                    return label; // Convert to plain text
                }
                return match;
            });

            // Strip absolute markdown links to non-existent non-docs routes (e.g. /examples, /usage)
            let final = updated.replace(
                new RegExp(`\\[([^\\]]*)\\]\\(\\/(?!(?:${KNOWN_ROUTES_PATTERN}|assets)\\/|https?:)([^)]*)\\)`, "g"),
                (match, label, linkPath) => {
                    const firstSegment = linkPath.split(/[/#]/)[0];
                    if (KNOWN_ROUTES.has(firstSegment)) {
                        return match;
                    }
                    changed = true;
                    return label;
                },
            );

            // Fix broken JSX href="/docs/..." links — remove the href to make it a plain element
            final = final.replace(/href="\/docs\/(.*?)"/g, (match, docPath) => {
                const cleanPath = docPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(contentRoot, cleanPath);

                const exists =
                    existsSync(resolved + ".mdx") ||
                    existsSync(resolved + ".md") ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"));

                if (!exists) {
                    changed = true;
                    return ""; // Remove broken href
                }
                return match;
            });

            // Fix broken JSX root-relative href links (e.g. href="/installation")
            final = final.replace(new RegExp(`href="\\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|docs)\\/|https?:)[^"]*)"`, "g"), (match, linkPath) => {
                const firstSegment = linkPath.split(/[/#]/)[0];
                if (KNOWN_ROUTES.has(firstSegment)) {
                    return match;
                }
                changed = true;
                return ""; // Remove broken href
            });

            if (changed) {
                await fs.writeFile(fullPath, final);
            }
        }
    }
}

/**
 * Rewrites absolute /docs/ links and root-relative links in MDX files.
 * - /docs/guide/foo → /docs/packages/{pkgName}/guide/foo
 * - /usage/foo → /docs/packages/{pkgName}/usage/foo (if target exists in package docs)
 */
async function rewriteDocsLinks(destPath, pkgName, pkgRoot) {
    pkgRoot = pkgRoot || destPath;
    const entries = await fs.readdir(destPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(destPath, entry.name);

        if (entry.isDirectory()) {
            await rewriteDocsLinks(fullPath, pkgName, pkgRoot);
        } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
            const original = await fs.readFile(fullPath, "utf-8");
            let content = original;

            // Rewrite /docs/ links (markdown syntax)
            content = content.replace(/(\[.*?\]\()\/docs\/(?!packages\/)(.*?\))/g, (match, prefix, restPath) => {
                if (restPath.startsWith(`${pkgName}/`) || restPath.startsWith(`${pkgName})`)) {
                    return `${prefix}/docs/packages/${restPath}`;
                }
                return `${prefix}/docs/packages/${pkgName}/${restPath}`;
            });

            // Rewrite /docs/ links (JSX href syntax)
            content = content.replace(/href="\/docs\/(?!packages\/)(.*?)"/g, (match, restPath) => {
                if (restPath.startsWith(`${pkgName}/`) || restPath === pkgName) {
                    return `href="/docs/packages/${restPath}"`;
                }
                return `href="/docs/packages/${pkgName}/${restPath}"`;
            });

            // Rewrite root-relative links (e.g. /usage/foo, /usage#anchor) that match existing package docs (markdown syntax)
            content = content.replace(
                new RegExp(`(\\[.*?\\]\\()\\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|api)\\/)[\\w-]+(?:[/#][^)]*)?)\\)`, "g"),
                (match, prefix, linkPath) => {
                    const cleanPath = linkPath.replace(/#.*$/, "").replace(/\/$/, "");
                    const resolved = path.join(pkgRoot, cleanPath);

                    if (
                        existsSync(resolved + ".mdx") ||
                        existsSync(resolved + ".md") ||
                        existsSync(path.join(resolved, "index.mdx")) ||
                        existsSync(path.join(resolved, "index.md"))
                    ) {
                        return `${prefix}/docs/packages/${pkgName}/${linkPath})`;
                    }
                    return match;
                },
            );

            // Rewrite root-relative links (JSX href syntax)
            content = content.replace(
                new RegExp(`href="\\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|api|docs)\\/|https?:)[\\w-]+(?:[/#][^"]*)?)"`, "g"),
                (match, linkPath) => {
                    const cleanPath = linkPath.replace(/#.*$/, "").replace(/\/$/, "");
                    const resolved = path.join(pkgRoot, cleanPath);

                    if (
                        existsSync(resolved + ".mdx") ||
                        existsSync(resolved + ".md") ||
                        existsSync(path.join(resolved, "index.mdx")) ||
                        existsSync(path.join(resolved, "index.md"))
                    ) {
                        return `href="/docs/packages/${pkgName}/${linkPath}"`;
                    }
                    return match;
                },
            );

            // Convert relative ./path links to absolute /docs/packages/{pkgName}/... paths
            const fileDir = path.dirname(fullPath);
            content = content.replace(/(\[.*?\]\()\.\/([^)]+)\)/g, (match, prefix, relPath) => {
                // Compute the absolute docs path from the file's directory
                const relToRoot = path.relative(pkgRoot, fileDir);
                const absPath = relToRoot ? `${relToRoot}/${relPath}` : relPath;
                return `${prefix}/docs/packages/${pkgName}/${absPath})`;
            });

            if (content !== original) {
                await fs.writeFile(fullPath, content);
            }
        }
    }
}

/**
 * Generates a basic meta.json from the directory contents when none exists.
 */
async function generateMetaJson(destPath) {
    const entries = await fs.readdir(destPath, { withFileTypes: true });
    const pages = ["index"];

    for (const entry of entries) {
        if (entry.name === "meta.json" || entry.name === "index.mdx" || entry.name === "index.md") {
            continue;
        }

        if (entry.isDirectory()) {
            pages.push(entry.name);
        } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
            pages.push(path.basename(entry.name, path.extname(entry.name)));
        }
    }

    const title = path
        .basename(destPath)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

    const meta = { title, pages };
    await fs.writeFile(path.join(destPath, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(`    Generated meta.json for ${path.basename(destPath)}`);
}

/**
 * If a package docs folder has no index.mdx but has introduction.mdx,
 * rename introduction.mdx → index.mdx and update meta.json accordingly.
 */
async function ensureIndexPage(destPath) {
    const indexMdx = path.join(destPath, "index.mdx");
    const indexMd = path.join(destPath, "index.md");
    const introMdx = path.join(destPath, "introduction.mdx");

    // Already has an index page
    try {
        await fs.stat(indexMdx);
        return;
    } catch {}
    try {
        await fs.stat(indexMd);
        return;
    } catch {}

    // No index — check for introduction.mdx to rename
    try {
        await fs.stat(introMdx);
    } catch {
        return; // No introduction.mdx either, nothing to do
    }

    await fs.rename(introMdx, indexMdx);

    // Update references to "introduction" in sibling MDX files
    const siblings = await fs.readdir(destPath, { withFileTypes: true });
    for (const sibling of siblings) {
        if (!sibling.isFile() || (!sibling.name.endsWith(".mdx") && !sibling.name.endsWith(".md"))) {
            continue;
        }
        const sibPath = path.join(destPath, sibling.name);
        const sibContent = await fs.readFile(sibPath, "utf-8");
        // Replace links like ./introduction, ../introduction, (introduction) with directory root
        const updated = sibContent
            .replace(/(\[.*?\]\()\.\.\/introduction\)/g, "$1../)")
            .replace(/(\[.*?\]\()\.\/introduction\)/g, "$1./)")
            .replace(/(\[.*?\]\()introduction\)/g, "$1./)");
        if (updated !== sibContent) {
            await fs.writeFile(sibPath, updated);
        }
    }

    // Update meta.json: replace "introduction" with "index" in pages array
    const metaPath = path.join(destPath, "meta.json");
    try {
        const metaContent = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent);
        if (Array.isArray(meta.pages)) {
            meta.pages = meta.pages.map((p) => (p === "introduction" ? "index" : p));
        }
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
    } catch {
        // No meta.json exists — generate one from the directory contents
        await generateMetaJson(destPath);
    }

    console.log(`    Renamed introduction.mdx → index.mdx in ${path.basename(destPath)}`);
}

/**
 * Finds all packages with a docs/ directory and copies them
 * into apps/web/src/content/docs/packages/{package-name}/.
 */
async function main() {
    // Clean destination
    await fs.rm(DEST_DIR, { recursive: true, force: true });
    await fs.mkdir(DEST_DIR, { recursive: true });

    // Clean public assets from packages
    await fs.rm(PUBLIC_ASSETS_DIR, { recursive: true, force: true });

    // Scan flat packages/{package}/docs (Lunora has no category sub-folders)
    const packages = await fs.readdir(PACKAGES_DIR, { withFileTypes: true });

    let copied = 0;

    for (const pkg of packages) {
        if (!pkg.isDirectory()) {
            continue;
        }

        const docsPath = path.join(PACKAGES_DIR, pkg.name, "docs");

        try {
            const stat = await fs.stat(docsPath);

            if (!stat.isDirectory()) {
                continue;
            }
        } catch (err) {
            if (err.code === "ENOENT") {
                continue;
            }
            throw err;
        }

        const destPath = path.join(DEST_DIR, pkg.name);

        await copyDirectory(docsPath, destPath);
        console.log(`  ${pkg.name}/docs → packages/${pkg.name}`);
        copied++;

        // If no index.mdx exists but introduction.mdx does, rename it so fumadocs resolves the folder root
        await ensureIndexPage(destPath);

        // Rewrite absolute /docs/ links to include the package prefix
        await rewriteDocsLinks(destPath, pkg.name);

        // Ensure meta.json exists (generate if missing)
        const metaPath = path.join(destPath, "meta.json");
        try {
            await fs.stat(metaPath);
        } catch {
            await generateMetaJson(destPath);
        }

        // Copy __assets__ to public/assets/{package-name}/ if present
        const assetsPath = path.join(PACKAGES_DIR, pkg.name, "__assets__");

        try {
            const assetsStat = await fs.stat(assetsPath);

            if (assetsStat.isDirectory()) {
                const assetsDestPath = path.join(PUBLIC_ASSETS_DIR, pkg.name);
                await fs.mkdir(assetsDestPath, { recursive: true });

                const assetFiles = await fs.readdir(assetsPath, { withFileTypes: true });

                for (const asset of assetFiles) {
                    if (asset.isFile()) {
                        await fs.copyFile(path.join(assetsPath, asset.name), path.join(assetsDestPath, asset.name));
                    }
                }

                console.log(`  ${pkg.name}/__assets__ → public/assets/${pkg.name}`);
            }
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
    }

    // Fetch docs from external repositories
    for (const external of EXTERNAL_DOCS) {
        try {
            const fetched = await fetchExternalDocs(external);

            if (fetched) {
                copied++;
            }
        } catch (error) {
            console.warn(`  Warning: Failed to fetch docs from ${external.repo}: ${error.message}`);
        }
    }

    console.log(`\nCopied docs from ${copied} packages into src/content/docs/packages/`);

    // Validate and fix broken internal doc links
    await fixBrokenDocsLinks(DEST_DIR);
    console.log("Validated internal doc links (broken links converted to plain text)");

    // Generate root packages/meta.json with categorized sidebar navigation
    const copiedPackages = await fs.readdir(DEST_DIR, { withFileTypes: true });
    const availablePackages = new Set(copiedPackages.filter((d) => d.isDirectory()).map((d) => d.name));

    const pages = [];

    for (const config of Object.values(CATEGORY_CONFIG)) {
        const categoryPackages = config.packages.filter((pkg) => availablePackages.has(pkg));

        if (categoryPackages.length === 0) {
            continue;
        }

        pages.push(`---${config.title}---`);
        pages.push(...categoryPackages);

        // Remove from available set to track uncategorized packages
        for (const pkg of categoryPackages) {
            availablePackages.delete(pkg);
        }
    }

    // Add any uncategorized packages at the end
    if (availablePackages.size > 0) {
        pages.push("---Other---");
        pages.push(...[...availablePackages].sort());
    }

    const rootMeta = {
        title: "Packages",
        pages: ["index", ...pages],
    };

    await fs.writeFile(path.join(DEST_DIR, "meta.json"), JSON.stringify(rootMeta, null, 4) + "\n");
    console.log("Generated packages/meta.json with categorized navigation");

    // Copy the static packages index page
    const indexSrc = path.join(__dirname, "..", "src", "content", "docs-static", "packages-index.mdx");

    try {
        await fs.stat(indexSrc);
        await fs.copyFile(indexSrc, path.join(DEST_DIR, "index.mdx"));
        console.log("Copied packages/index.mdx from static source");
    } catch {
        console.log("Warning: docs-static/packages-index.mdx not found, skipping index generation");
    }
}

/**
 * Copies root-level markdown files (e.g. CODE_OF_CONDUCT.md) into
 * apps/web/src/content/ so they can be compiled as MDX at build time.
 */
async function copyRootMarkdown() {
    const contentDir = path.join(__dirname, "..", "src", "content");
    await fs.mkdir(contentDir, { recursive: true });

    const files = [{ src: path.join(ROOT_DIR, ".github", "CODE_OF_CONDUCT.md"), dest: path.join(contentDir, "code-of-conduct.md") }];

    for (const { src, dest } of files) {
        try {
            await fs.copyFile(src, dest);
            console.log(`Copied ${path.relative(ROOT_DIR, src)} → ${path.relative(path.join(__dirname, ".."), dest)}`);
        } catch {
            console.warn(`Warning: ${path.relative(ROOT_DIR, src)} not found, skipping`);
        }
    }
}

Promise.all([main(), copyRootMarkdown()]).catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
