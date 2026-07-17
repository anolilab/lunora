import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CATEGORY_TITLES, categorySlugForPackageDir, categoryTitleForSlug, orderPackagesInCategory } from "./package-categories.js";

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
 * Derives the docs/showcase slug from an npm name — kept in sync with
 * generate-packages.js so the generated docs folder matches the slug the
 * packages index links to. "@lunora/server" → "server"; the unscoped
 * umbrella "lunorash" (dir `packages/lunora/`) → "lunorash".
 * @param npmName
 */
function slugFromNpmName(npmName) {
    if (npmName.startsWith("@lunora/")) {
        return npmName.slice("@lunora/".length);
    }

    return npmName;
}

/**
 * Reads a package's npm name from its package.json and returns the docs slug.
 * Falls back to the directory name if the manifest is missing or unreadable.
 * @param dirName
 */
async function slugForPackageDir(dirName) {
    try {
        const pkgJson = JSON.parse(await fs.readFile(path.join(PACKAGES_DIR, dirName, "package.json"), "utf8"));

        if (pkgJson.name) {
            return slugFromNpmName(pkgJson.name);
        }
    } catch {
        // ignore — fall back to the directory name below
    }

    return dirName;
}

/**
 * Sanitizes meta.json pages array for fumadocs compatibility.
 * Converts object entries (e.g. { title: "Section", pages: [...] }) into
 * fumadocs-native separator + folder reference format.
 * @param filePath
 */
async function sanitizeMetaJson(filePath) {
    const content = await fs.readFile(filePath, "utf8");
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

    await fs.writeFile(filePath, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Ensures MDX files have valid frontmatter with a title
 * and performs compatibility fixes for fumadocs.
 * @param filePath
 */
async function sanitizeMdx(filePath) {
    let content = await fs.readFile(filePath, "utf8");

    // 1. Strip relative component/utility imports (e.g., from external repo docs)
    content = content.replaceAll(/^import\s+(?:\S.*)?from\s+['"]\.\.?\/(?:components|utils)\/.*['"];?\s*$/gm, "");

    // 2. Replace unsupported code block languages with supported alternatives
    content = content.replaceAll(/^```env$/gm, "```bash");
    content = content.replaceAll(/^```npm$/gm, "```bash");

    // 3. Strip corrupted LLM artifacts (fullwidth pipe characters, tool call markers)
    content = content.replaceAll(/<｜[^｜]*｜>/g, "");

    // 4. Escape ALL angle brackets outside code blocks that aren't standard HTML tags.
    // This prevents MDX from interpreting TypeScript generics, comparison operators,
    // and other non-HTML angle brackets as JSX.
    const codeBlockRegex = /(```[\s\S]*?```|`[^`]+`)/g;
    const parts = content.split(codeBlockRegex);

    const fumadocsComponents =
        "Callout|Tab|Tabs|Cards|Card|Steps|Step|Files|Folder|File|DocsCategory|CodeBlockTabs|CodeBlockTabsList|CodeBlockTabsTrigger|CodeBlockTab|Accordions|Accordion|TypeTable|AutoTypeTable|ImageZoom";
    const safeHtmlTags = `div|span|a|p|ul|ol|li|h[1-6]|br|hr|img|code|pre|em|strong|b|i|u|table|thead|tbody|tfoot|tr|td|th|details|summary|blockquote|section|nav|footer|header|main|aside|figure|figcaption|dl|dt|dd|sup|sub|del|ins|mark|small|abbr|cite|dfn|kbd|samp|var|wbr|!--|${fumadocsComponents}`;
    const safeTagRegex = new RegExp(String.raw`<(?!\/?(?:${safeHtmlTags})[\s>/])`, "g");

    content = parts
        .map((part, i) => {
            if (i % 2 === 1) {
                return part;
            } // code block - don't modify
            // Escape non-HTML angle brackets
            let result = part.replaceAll(safeTagRegex, String.raw`\<`);
            // Strip .mdx/.md extensions from markdown links (they break URL routing)
            result = result.replaceAll(/(\[[^\]]*\]\([^)]*?)\.mdx(\))/g, "$1$2");
            result = result.replaceAll(/(\[[^\]]*\]\([^)]*?)\.md(\))/g, "$1$2");
            return result;
        })
        .join("");

    // 5. Quote frontmatter values containing YAML special characters (@, :, #, etc.)
    if (content.startsWith("---")) {
        const fmEnd = content.indexOf("---", 3);

        if (fmEnd !== -1) {
            const frontmatter = content.substring(3, fmEnd);
            const fixedFm = frontmatter.replaceAll(/^(\w[\w-]*):\s+(?!["'|>])(.+)$/gm, (match, key, value) => {
                if (/[@:#{}[\],&*?|><!%`]/.test(value)) {
                    const escapedValue = value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`);

                    return `${key}: "${escapedValue}"`;
                }
                return match;
            });
            content = `---${fixedFm}---${content.slice(Math.max(0, fmEnd + 3))}`;
        }
    }

    // 6. Add frontmatter if missing
    if (!content.startsWith("---")) {
        const basename = path.basename(filePath, path.extname(filePath));
        const title = basename.replaceAll(/[-_]/g, " ").replaceAll(/\b\w/g, (c) => c.toUpperCase());

        content = `---\ntitle: "${title}"\n---\n\n${content}`;
    }

    await fs.writeFile(filePath, content);
}

/**
 * Recursively copies a directory.
 * @param src
 * @param dest
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
 * @param root0
 * @param root0.repo
 * @param root0.branches
 * @param root0.docsPath
 * @param root0.destName
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
    } catch (error) {
        if (error.code === "ENOENT") {
            console.warn(`  Warning: ${docsPath}/ not found in ${repo}@${targetBranch}, skipping`);
            await fs.rm(tmpDir, { recursive: true, force: true });
            return false;
        }
        throw error;
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
 * @param dir
 * @param contentRoot
 */
async function fixBrokenDocsLinks(dir, contentRoot) {
    contentRoot = contentRoot || path.join(dir, "..");
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            await fixBrokenDocsLinks(fullPath, contentRoot);
        } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
            const content = await fs.readFile(fullPath, "utf8");
            let changed = false;

            // Fix broken markdown-style /docs/ links
            const updated = content.replaceAll(/\[([^\]]*)\]\(\/docs\/(.*?)\)/g, (match, label, docPath) => {
                // Strip hash fragments and trailing slashes for resolution
                const cleanPath = docPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(contentRoot, cleanPath);

                // Check if the target exists as a file or directory with index
                const exists =
                    existsSync(`${resolved}.mdx`) ||
                    existsSync(`${resolved}.md`) ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"));

                if (!exists) {
                    changed = true;
                    return label; // Convert to plain text
                }
                return match;
            });

            // Strip absolute markdown links to non-existent non-docs routes (e.g. /examples, /usage)
            let final = updated.replaceAll(
                new RegExp(String.raw`\[([^\]]*)\]\(\/(?!(?:${KNOWN_ROUTES_PATTERN}|assets)\/|https?:)([^)]*)\)`, "g"),
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
            final = final.replaceAll(/href="\/docs\/(.*?)"/g, (match, docPath) => {
                const cleanPath = docPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(contentRoot, cleanPath);

                const exists =
                    existsSync(`${resolved}.mdx`) ||
                    existsSync(`${resolved}.md`) ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"));

                if (!exists) {
                    changed = true;
                    return ""; // Remove broken href
                }
                return match;
            });

            // Fix broken JSX root-relative href links (e.g. href="/installation")
            final = final.replaceAll(new RegExp(String.raw`href="\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|docs)\/|https?:)[^"]*)"`, "g"), (match, linkPath) => {
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
 * @param destPath
 * @param pkgName
 * @param pkgRoot
 */
async function rewriteDocsLinks(destPath, pkgName, pkgRoot) {
    pkgRoot = pkgRoot || destPath;
    const entries = await fs.readdir(destPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(destPath, entry.name);

        if (entry.isDirectory()) {
            await rewriteDocsLinks(fullPath, pkgName, pkgRoot);
        } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
            const original = await fs.readFile(fullPath, "utf8");
            let content = original;

            // Rewrite /docs/ links (markdown syntax). Only re-home a /docs/<x> link under
            // this package when <x> is actually a page inside the package; otherwise it's a
            // cross-section link to a top-level doc route (/docs/concepts, /docs/architecture,
            // …) and must be left intact — rewriting it would create a dead path that the
            // broken-link pass then strips to plain text.
            content = content.replaceAll(/(\[.*?\]\()\/docs\/(?!packages\/)(.*?)(\))/g, (match, prefix, restPath, close) => {
                if (restPath.startsWith(`${pkgName}/`) || restPath === pkgName) {
                    return `${prefix}/docs/packages/${restPath}${close}`;
                }
                const cleanPath = restPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(pkgRoot, cleanPath);
                if (
                    existsSync(`${resolved}.mdx`) ||
                    existsSync(`${resolved}.md`) ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"))
                ) {
                    return `${prefix}/docs/packages/${pkgName}/${restPath}${close}`;
                }
                return match;
            });

            // Rewrite /docs/ links (JSX href syntax) — same package-vs-cross-section guard.
            content = content.replaceAll(/href="\/docs\/(?!packages\/)(.*?)"/g, (match, restPath) => {
                if (restPath.startsWith(`${pkgName}/`) || restPath === pkgName) {
                    return `href="/docs/packages/${restPath}"`;
                }
                const cleanPath = restPath.replace(/#.*$/, "").replace(/\/$/, "");
                const resolved = path.join(pkgRoot, cleanPath);
                if (
                    existsSync(`${resolved}.mdx`) ||
                    existsSync(`${resolved}.md`) ||
                    existsSync(path.join(resolved, "index.mdx")) ||
                    existsSync(path.join(resolved, "index.md"))
                ) {
                    return `href="/docs/packages/${pkgName}/${restPath}"`;
                }
                return match;
            });

            // Rewrite root-relative links (e.g. /usage/foo, /usage#anchor) that match existing package docs (markdown syntax)
            content = content.replaceAll(
                new RegExp(String.raw`(\[.*?\]\()\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|api)\/)[\w-]+(?:[/#][^)]*)?)\)`, "g"),
                (match, prefix, linkPath) => {
                    const cleanPath = linkPath.replace(/#.*$/, "").replace(/\/$/, "");
                    const resolved = path.join(pkgRoot, cleanPath);

                    if (
                        existsSync(`${resolved}.mdx`) ||
                        existsSync(`${resolved}.md`) ||
                        existsSync(path.join(resolved, "index.mdx")) ||
                        existsSync(path.join(resolved, "index.md"))
                    ) {
                        return `${prefix}/docs/packages/${pkgName}/${linkPath})`;
                    }
                    return match;
                },
            );

            // Rewrite root-relative links (JSX href syntax)
            content = content.replaceAll(
                new RegExp(String.raw`href="\/((?!(?:${KNOWN_ROUTES_PATTERN}|assets|api|docs)\/|https?:)[\w-]+(?:[/#][^"]*)?)"`, "g"),
                (match, linkPath) => {
                    const cleanPath = linkPath.replace(/#.*$/, "").replace(/\/$/, "");
                    const resolved = path.join(pkgRoot, cleanPath);

                    if (
                        existsSync(`${resolved}.mdx`) ||
                        existsSync(`${resolved}.md`) ||
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
            content = content.replaceAll(/(\[.*?\]\()\.\/([^)]+)\)/g, (match, prefix, relPath) => {
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
 * @param destPath
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
        .replaceAll(/[-_]/g, " ")
        .replaceAll(/\b\w/g, (c) => c.toUpperCase());

    const meta = { title, pages };
    await fs.writeFile(path.join(destPath, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`    Generated meta.json for ${path.basename(destPath)}`);
}

/**
 * If a package docs folder has no index.mdx but has introduction.mdx,
 * rename introduction.mdx → index.mdx and update meta.json accordingly.
 * @param destPath
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
        const sibContent = await fs.readFile(sibPath, "utf8");
        // Replace links like ./introduction, ../introduction, (introduction) with directory root
        const updated = sibContent
            .replaceAll(/(\[.*?\]\()\.\.\/introduction\)/g, "$1../)")
            .replaceAll(/(\[.*?\]\()\.\/introduction\)/g, "$1./)")
            .replaceAll(/(\[.*?\]\()introduction\)/g, "$1./)");
        if (updated !== sibContent) {
            await fs.writeFile(sibPath, updated);
        }
    }

    // Update meta.json: replace "introduction" with "index" in pages array
    const metaPath = path.join(destPath, "meta.json");
    try {
        const metaContent = await fs.readFile(metaPath, "utf8");
        const meta = JSON.parse(metaContent);
        if (Array.isArray(meta.pages)) {
            meta.pages = meta.pages.map((p) => (p === "introduction" ? "index" : p));
        }
        await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
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

    // Docs slug → category slug (from the package's project.json `category:*`
    // tag), collected while copying so the sidebar below is derived from the
    // filesystem instead of a hard-coded package list.
    const categoryBySlug = new Map();

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
        } catch (error) {
            if (error.code === "ENOENT") {
                continue;
            }
            throw error;
        }

        // The docs folder + every internal link uses the npm-name slug
        // (e.g. `lunorash` for the `packages/lunora/` umbrella), matching the
        // slug generate-packages.js emits and the packages index links to.
        const slug = await slugForPackageDir(pkg.name);
        const destPath = path.join(DEST_DIR, slug);

        categoryBySlug.set(slug, categorySlugForPackageDir(path.join(PACKAGES_DIR, pkg.name)));

        await copyDirectory(docsPath, destPath);
        console.log(`  ${pkg.name}/docs → packages/${slug}`);
        copied++;

        // If no index.mdx exists but introduction.mdx does, rename it so fumadocs resolves the folder root
        await ensureIndexPage(destPath);

        // Rewrite absolute /docs/ links to include the package prefix
        await rewriteDocsLinks(destPath, slug);

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
                const assetsDestPath = path.join(PUBLIC_ASSETS_DIR, slug);
                await fs.mkdir(assetsDestPath, { recursive: true });

                const assetFiles = await fs.readdir(assetsPath, { withFileTypes: true });

                for (const asset of assetFiles) {
                    if (asset.isFile()) {
                        await fs.copyFile(path.join(assetsPath, asset.name), path.join(assetsDestPath, asset.name));
                    }
                }

                console.log(`  ${pkg.name}/__assets__ → public/assets/${slug}`);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
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

    // Generate root packages/meta.json with categorized sidebar navigation.
    // Membership comes from each package's project.json `category:*` tag
    // (collected above), so every copied docs folder surfaces — packages with
    // an unknown category get a humanized section after the known ones, and
    // anything without a tag (e.g. external docs) lands under "Other".
    const copiedPackages = await fs.readdir(DEST_DIR, { withFileTypes: true });
    const availablePackages = new Set(copiedPackages.filter((d) => d.isDirectory()).map((d) => d.name));

    const slugsByCategory = new Map();

    for (const slug of availablePackages) {
        const categorySlug = categoryBySlug.get(slug) ?? null;
        const bucket = slugsByCategory.get(categorySlug) ?? [];

        bucket.push(slug);
        slugsByCategory.set(categorySlug, bucket);
    }

    // Known categories in declared order, then any unknown category slugs.
    const orderedCategorySlugs = [
        ...Object.keys(CATEGORY_TITLES).filter((slug) => slugsByCategory.has(slug)),
        ...[...slugsByCategory.keys()].filter((slug) => slug !== null && !(slug in CATEGORY_TITLES)).sort((a, b) => a.localeCompare(b)),
    ];

    const pages = [];

    for (const categorySlug of orderedCategorySlugs) {
        pages.push(`---${categoryTitleForSlug(categorySlug)}---`, ...orderPackagesInCategory(categorySlug, slugsByCategory.get(categorySlug)));
    }

    // Packages without a category tag at the end
    const uncategorized = slugsByCategory.get(null);

    if (uncategorized && uncategorized.length > 0) {
        pages.push("---Other---");
        pages.push(...uncategorized.sort((a, b) => a.localeCompare(b)));
    }

    const rootMeta = {
        title: "Packages",
        pages: ["index", ...pages],
    };

    await fs.writeFile(path.join(DEST_DIR, "meta.json"), `${JSON.stringify(rootMeta, null, 4)}\n`);
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

/**
 * Copies each package's generated CHANGELOG.md into
 * src/content/changelogs/<slug>.md (with a `title` frontmatter naming the
 * package) so the changelog route can bundle and render every package's
 * release notes. Packages without a CHANGELOG.md (not yet released) are
 * skipped. The destination dir is gitignored — these are build artifacts.
 */
async function copyChangelogs() {
    const destDir = path.join(__dirname, "..", "src", "content", "changelogs");
    await fs.mkdir(destDir, { recursive: true });

    const entries = await fs.readdir(PACKAGES_DIR, { withFileTypes: true });
    let copied = 0;

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const changelogPath = path.join(PACKAGES_DIR, entry.name, "CHANGELOG.md");

        if (!existsSync(changelogPath)) {
            continue;
        }

        const slug = await slugForPackageDir(entry.name);

        let npmName = slug;

        try {
            const pkgJson = JSON.parse(await fs.readFile(path.join(PACKAGES_DIR, entry.name, "package.json"), "utf8"));
            npmName = pkgJson.name ?? slug;
        } catch {
            // ignore — fall back to the slug as the display title
        }

        const body = await fs.readFile(changelogPath, "utf8");

        // The page already renders the package name as a section title, so drop
        // the redundant "## @scope/name " prefix from each version heading,
        // leaving just "## 1.2.3 (date)".
        const trimmed = body.replaceAll(`# ${npmName} `, "# ");
        const frontmatter = `---\ntitle: "${npmName}"\n---\n\n`;

        await fs.writeFile(path.join(destDir, `${slug}.md`), frontmatter + trimmed);
        copied += 1;
    }

    console.log(`Copied ${copied} package changelog(s) → src/content/changelogs`);
}

Promise.all([main(), copyRootMarkdown(), copyChangelogs()]).catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
