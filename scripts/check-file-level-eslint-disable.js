/**
 * Guards against new file-level `/* eslint-disable` blocks.
 *
 * AGENTS.md only accepts line-scoped disables with a reason. Existing
 * file-level disables are recorded in file-level-eslint-disable.baseline.json;
 * a file outside the baseline fails the check, and so does a baseline entry
 * that no longer violates, so the baseline can only shrink.
 *
 * A file violates when it contains a block comment starting `/* eslint-disable`
 * (not `-line` / `-next-line`) with no later `/* eslint-enable`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(rootDir, "scripts", "file-level-eslint-disable.baseline.json");

const SKIPPED_DIRS = new Set(["node_modules", "dist"]);

const walk = (dir, out) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) {
                walk(join(dir, entry.name), out);
            }
        } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
            out.push(join(dir, entry.name));
        }
    }
};

const roots = [join(rootDir, "shared")];

for (const pkg of readdirSync(join(rootDir, "packages"), { withFileTypes: true })) {
    if (pkg.isDirectory()) {
        roots.push(join(rootDir, "packages", pkg.name, "src"));
    }
}

const files = [];

for (const root of roots) {
    try {
        walk(root, files);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}

const DISABLE = /\/\*\s*eslint-disable(?!-line|-next-line)/g;
const ENABLE = /\/\*\s*eslint-enable/g;

const lastIndex = (text, pattern) => {
    let last = -1;

    for (const match of text.matchAll(pattern)) {
        last = match.index;
    }

    return last;
};

const violating = [];

for (const file of files) {
    const text = readFileSync(file, "utf8");
    const disable = lastIndex(text, DISABLE);

    if (disable !== -1 && lastIndex(text, ENABLE) < disable) {
        violating.push(relative(rootDir, file).split("\\").join("/"));
    }
}

violating.sort();

const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")));
const found = new Set(violating);
const added = violating.filter((file) => !baseline.has(file));
const stale = [...baseline].filter((file) => !found.has(file)).sort();

if (added.length > 0) {
    console.error("File-level eslint-disable is not accepted (use a line-scoped disable with a reason after `--`):");

    for (const file of added) {
        console.error(`  ${file}`);
    }
}

if (stale.length > 0) {
    console.error("Baseline entries that no longer violate (remove them from scripts/file-level-eslint-disable.baseline.json):");

    for (const file of stale) {
        console.error(`  ${file}`);
    }
}

process.exit(added.length > 0 || stale.length > 0 ? 1 : 0);
