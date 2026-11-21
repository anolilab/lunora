/**
 * Guards against new file-level `/* eslint-disable` blocks.
 *
 * AGENTS.md only accepts line-scoped disables with a reason. Existing
 * file-level disables are recorded in file-level-eslint-disable.baseline.json;
 * a file outside the baseline fails the check, and so does a baseline entry
 * that no longer violates, so the baseline can only shrink.
 *
 * A file violates when a block-comment `/* eslint-disable` directive (not
 * `-line` / `-next-line`) leaves a rule disabled at the end of the file: a bare
 * enable re-enables every rule, a named one only the rules it lists. Directives
 * are read from real comments, so one quoted in a string or template is ignored.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(rootDir, "scripts", "file-level-eslint-disable.baseline.json");

// Build output and codegen's emitted files, which carry their own generated headers.
const SKIPPED_DIRS = new Set(["_generated", "coverage", "dist", "node_modules"]);

const walk = (dir, out) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) {
                walk(join(dir, entry.name), out);
            }
        } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.gen\.[cm]?[jt]sx?$/.test(entry.name)) {
            out.push(join(dir, entry.name));
        }
    }
};

// Every linted tree: a package's tests and smoke apps are linted as well as its `src/`.
const roots = [join(rootDir, "shared")];

for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(join(rootDir, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) {
            roots.push(join(rootDir, parent, entry.name));
        }
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

const MAYBE_DIRECTIVE = /eslint-(?:disable|enable)(?!-line|-next-line)/;
const DIRECTIVE = /^\/\*\s*eslint-(disable|enable)(?!-line|-next-line)(?:\s+([\s\S]*?))?\s*(?:--[\s\S]*)?\*\/$/;

/** Every comment in the file, in order: the leading and trailing trivia of each token the parser produced. */
const commentsOf = (fileName, text) => {
    const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
    const seen = new Map();

    const visit = (node) => {
        for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) {
            seen.set(range.pos, range);
        }

        for (const child of node.getChildren(source)) {
            visit(child);
        }
    };

    visit(source);

    return [...seen.values()].sort((a, b) => a.pos - b.pos).map((range) => text.slice(range.pos, range.end));
};

/** Whether a rule is still disabled once every block directive in the file has applied. */
const leavesRuleDisabled = (fileName, text) => {
    let all = false;
    const rules = new Set();

    for (const comment of commentsOf(fileName, text)) {
        const match = DIRECTIVE.exec(comment);

        if (match === null) {
            continue;
        }

        const [, verb, list = ""] = match;
        const named = list
            .split(",")
            .map((rule) => rule.trim())
            .filter(Boolean);

        if (verb === "disable") {
            if (named.length === 0) {
                all = true;
            } else {
                for (const rule of named) {
                    rules.add(rule);
                }
            }
        } else if (named.length === 0) {
            all = false;
            rules.clear();
        } else {
            for (const rule of named) {
                rules.delete(rule);
            }
        }
    }

    return all || rules.size > 0;
};

const violating = [];

for (const file of files) {
    const text = readFileSync(file, "utf8");

    // Parsing is the expensive part, and almost no file mentions a block directive at all.
    if (MAYBE_DIRECTIVE.test(text) && leavesRuleDisabled(file, text)) {
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
