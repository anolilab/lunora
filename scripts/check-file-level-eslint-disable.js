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
 * A disable/enable pair that encloses every statement counts as file-level too.
 *
 * With GITHUB_BASE_REF set (a pull request), a baseline entry the base
 * branch's baseline lacks fails the check as well.
 */

import { execFileSync } from "node:child_process";
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

/** The parsed file, and every comment in it in order: the leading and trailing trivia of each token. */
const parse = (fileName, text) => {
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

    return { comments: [...seen.values()].sort((left, right) => left.pos - right.pos), source };
};

const ALL_RULES = "*";

/**
 * Whether a block directive disables a rule for the whole file: one still disabled at the end of it,
 * or a disable/enable pair that encloses every statement (an enable after the last line excuses
 * nothing). Each disabled rule remembers where its disable sits; a bare enable closes them all.
 */
const isFileLevel = (fileName, text) => {
    const { comments, source } = parse(fileName, text);
    const { statements } = source;
    const firstStart = statements.length === 0 ? undefined : statements[0].getStart(source);
    const lastEnd = statements.length === 0 ? undefined : statements.at(-1).end;
    const open = new Map();
    const enclosesFile = (disabledAt, enabledAt) => firstStart !== undefined && disabledAt <= firstStart && enabledAt >= lastEnd;

    for (const range of comments) {
        const match = DIRECTIVE.exec(text.slice(range.pos, range.end));

        if (match === null) {
            continue;
        }

        const [, verb, list = ""] = match;
        const named = list
            .split(",")
            .map((rule) => rule.trim())
            .filter(Boolean);
        const rules = named.length === 0 ? [ALL_RULES] : named;

        if (verb === "disable") {
            for (const rule of rules) {
                if (!open.has(rule)) {
                    open.set(rule, range.pos);
                }
            }

            continue;
        }

        const closing = named.length === 0 ? [...open.keys()] : rules.filter((rule) => open.has(rule));

        for (const rule of closing) {
            if (enclosesFile(open.get(rule), range.pos)) {
                return true;
            }

            open.delete(rule);
        }
    }

    return open.size > 0;
};

const violating = [];

for (const file of files) {
    const text = readFileSync(file, "utf8");

    // Parsing is the expensive part, and almost no file mentions a block directive at all.
    if (MAYBE_DIRECTIVE.test(text) && isFileLevel(file, text)) {
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

// In a pull request the baseline may only shrink against the base branch's: a PR that adds a file-level
// disable and its own baseline entry together would otherwise pass. Skipped when the base ref or its
// baseline is not available (a first run, or a base that predates this guard).
const baseRef = process.env.GITHUB_BASE_REF;
let approvedHere = [];

if (baseRef) {
    let baseBaseline;

    try {
        const baselineInRepo = relative(rootDir, baselinePath).split("\\").join("/");

        baseBaseline = new Set(
            JSON.parse(
                execFileSync("git", ["show", `origin/${baseRef}:${baselineInRepo}`], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
            ),
        );
    } catch {
        baseBaseline = undefined;
    }

    if (baseBaseline !== undefined) {
        approvedHere = [...baseline].filter((file) => !baseBaseline.has(file)).sort();
    }
}

if (approvedHere.length > 0) {
    console.error(`Baseline entries this change adds that origin/${String(baseRef)}'s baseline does not have (fix the disable instead):`);

    for (const file of approvedHere) {
        console.error(`  ${file}`);
    }
}

process.exit(added.length > 0 || stale.length > 0 || approvedHere.length > 0 ? 1 : 0);
