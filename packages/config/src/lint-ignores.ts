/* eslint-disable jsdoc/check-indentation -- intentional nested bullet list documenting each tool's ignore mechanism */

/**
 * Teach a project's linter and formatter to skip Lunora's generated artifacts.
 *
 * # Why this is the framework's job
 *
 * `_generated/` is an output artifact that behaves like source: it lands in the
 * repo, it is compiled under the project's own strict settings, and — for
 * projects that commit it — it is diffed in review. So every consumer
 * independently rediscovers the same handful of paths, and until they do, a lint
 * run reports thousands of errors in files nobody wrote. One port measured
 * 23,553 ESLint errors, effectively all of them from generated output.
 *
 * `.gitignore` is not the answer on its own. Two of these paths are committed on
 * purpose (the schema-drift baseline is the whole point of the deploy gate), and
 * a project may legitimately commit `_generated/` so the API surface is
 * reviewable — at which point every gitignore-derived exclusion stops applying.
 *
 * # Why per-tool writers rather than one file
 *
 * There is no shared ignore-file format, and the differences are not cosmetic:
 *
 * - **Prettier** reads `.prettierignore`, gitignore syntax. Trivial.
 * - **oxlint** takes `ignorePatterns` in `.oxlintrc.json`, also gitignore-style
 *   (confirmed against its published `configuration_schema.json`).
 * - **Biome v2** has no ignore key at all — exclusions are negated patterns in
 *   `files.includes`. v1's `files.ignore` still exists in the wild, so the writer
 *   picks whichever key the config already uses rather than sniffing versions.
 * - **ESLint** flat config **removed `.eslintignore`**. Writing one would be
 *   worse than doing nothing: ESLint warns that the file is unsupported and then
 *   ignores it, so the project would carry a file that looks like it works.
 *   Ignores must live in `eslint.config.*`.
 *
 * That last one is why {@link applyLintIgnores} can create an ESLint config but
 * will not edit an existing one — it is arbitrary JavaScript, and a
 * regex-or-AST rewrite of a user's lint config is not a thing to do silently.
 * It reports {@link LintIgnoreStatus} `"manual"` with the exact snippet instead.
 */
/* eslint-enable jsdoc/check-indentation */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import { applyModify } from "./jsonc-edit";

/**
 * The generated and derived paths a linter or formatter should skip, in
 * gitignore syntax relative to the project root.
 *
 * Committed-on-purpose entries are in here too, deliberately: being tracked by
 * git says nothing about whether a human should be asked to reformat it.
 */
const LUNORA_IGNORED_PATHS: ReadonlyArray<string> = [
    // Codegen output — api.ts, server.ts, dataModel.ts, and the rest.
    "lunora/_generated/",
    // The committed structural snapshot the pre-deploy drift gate diffs against.
    "lunora/.lunora-schema.json",
    // The advisor's scored health map, rewritten by every `lunora advisor` run.
    "lunora.advisor.map.json",
    // CLI state and build artifacts (`.lunora/build`, caches).
    ".lunora/",
    // wrangler's local state and generated types.
    ".wrangler/",
];

/** A linter or formatter this module knows how to configure. */
type LintTool = "biome" | "eslint" | "oxlint" | "prettier";

/**
 * What happened to one tool's configuration. `"manual"` is not a failure — it
 * means the change is correct but not safe to make automatically, and
 * {@link LintIgnoreOutcome.snippet} carries what to paste.
 */
type LintIgnoreStatus = "created" | "manual" | "unchanged" | "updated";

interface LintIgnoreOutcome {
    /** Config file that was written, or the one the user must edit for `"manual"`. */
    path: string;
    /** For `"manual"`: the exact text to add. */
    snippet?: string;
    status: LintIgnoreStatus;
    tool: LintTool;
}

/** Config filenames that identify a tool even when its dependency is not declared (a global install, or a monorepo root dep). */
const CONFIG_FILES: Record<LintTool, ReadonlyArray<string>> = {
    biome: ["biome.json", "biome.jsonc"],
    eslint: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"],
    oxlint: [".oxlintrc.json"],
    prettier: [
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.js",
        ".prettierrc.mjs",
        ".prettierrc.cjs",
        "prettier.config.js",
        "prettier.config.mjs",
        "prettier.config.cjs",
    ],
};

/** Package names that identify a tool from `package.json`. */
const TOOL_PACKAGES: Record<LintTool, ReadonlyArray<string>> = {
    biome: ["@biomejs/biome"],
    eslint: ["eslint"],
    oxlint: ["oxlint"],
    prettier: ["prettier"],
};

const ALL_TOOLS: ReadonlyArray<LintTool> = ["biome", "eslint", "oxlint", "prettier"];

/** Every declared dependency name in `projectRoot`'s manifest, across all dependency fields. */
const declaredPackages = (projectRoot: string): ReadonlySet<string> => {
    const manifestPath = join(projectRoot, "package.json");

    if (!existsSync(manifestPath)) {
        return new Set();
    }

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const names = new Set<string>();

        for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            const section = manifest[field];

            if (section !== null && typeof section === "object") {
                for (const name of Object.keys(section)) {
                    names.add(name);
                }
            }
        }

        // A `prettier` key in package.json IS a prettier config, and plenty of
        // projects configure it there instead of a dotfile.
        if (manifest["prettier"] !== undefined) {
            names.add("prettier");
        }

        return names;
    } catch {
        return new Set();
    }
};

/** The first existing config file for `tool`, or `undefined`. */
const findConfigFile = (projectRoot: string, tool: LintTool): string | undefined =>
    CONFIG_FILES[tool].map((name) => join(projectRoot, name)).find((path) => existsSync(path));

/**
 * Which linters/formatters this project already uses, by declared dependency or
 * config file on disk.
 *
 * Both signals matter: a dependency without a config is a tool about to be
 * configured, and a config without a dependency is a tool installed globally or
 * hoisted from a monorepo root. Missing either one means silently skipping a
 * tool the project genuinely runs.
 */
const detectLintTools = (projectRoot: string): LintTool[] => {
    const packages = declaredPackages(projectRoot);

    return ALL_TOOLS.filter((tool) => TOOL_PACKAGES[tool].some((name) => packages.has(name)) || findConfigFile(projectRoot, tool) !== undefined);
};

/** Marker comment so a re-run can tell its own block from lines the user added. */
const BLOCK_HEADER = "# Lunora generated + derived artifacts";

/** Create or extend `.prettierignore`, appending only the paths it does not already list. */
const applyPrettier = (projectRoot: string): LintIgnoreOutcome => {
    const path = join(projectRoot, ".prettierignore");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const lines = existing === undefined ? [] : existing.split("\n").map((line) => line.trim());
    const missing = LUNORA_IGNORED_PATHS.filter((entry) => !lines.includes(entry));

    if (missing.length === 0) {
        return { path, status: existing === undefined ? "created" : "unchanged", tool: "prettier" };
    }

    const block = `${BLOCK_HEADER}\n${missing.join("\n")}\n`;

    if (existing === undefined) {
        writeFileSync(path, block, "utf8");

        return { path, status: "created", tool: "prettier" };
    }

    writeFileSync(path, `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${block}`, "utf8");

    return { path, status: "updated", tool: "prettier" };
};

/** Merge `values` into the JSONC array at `pointer`, preserving comments and formatting; returns the outcome. */
const mergeJsonArray = (path: string, pointer: ReadonlyArray<string>, values: ReadonlyArray<string>, tool: LintTool): LintIgnoreOutcome => {
    // Captured BEFORE the write — reading it afterwards would always say the
    // file existed, so every `created` would be misreported as `updated`.
    const preexisting = existsSync(path);
    const text = preexisting ? readFileSync(path, "utf8") : "{}\n";
    const parsed = (parseJsonc(text) ?? {}) as Record<string, unknown>;

    let cursor: unknown = parsed;

    for (const key of pointer) {
        cursor = cursor !== null && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
    }

    const current = Array.isArray(cursor) ? (cursor as string[]) : [];
    const missing = values.filter((value) => !current.includes(value));

    if (missing.length === 0 && preexisting) {
        return { path, status: "unchanged", tool };
    }

    writeFileSync(path, applyModify(text, pointer, [...current, ...missing]), "utf8");

    return { path, status: preexisting ? "updated" : "created", tool };
};

/** Create or extend `.oxlintrc.json`'s `ignorePatterns` (gitignore-style, per oxlint's schema). */
const applyOxlint = (projectRoot: string): LintIgnoreOutcome =>
    mergeJsonArray(join(projectRoot, ".oxlintrc.json"), ["ignorePatterns"], LUNORA_IGNORED_PATHS, "oxlint");

/**
 * Extend Biome's exclusions.
 *
 * v2 dropped `files.ignore` for negated patterns in `files.includes`; v1 configs
 * still use `files.ignore`. Rather than sniff a version, follow whichever key
 * the config already has — that is the version's own answer, stated by the
 * project. A fresh config gets the v2 form, which needs a leading `"**"` for the
 * negations to subtract from.
 */
const applyBiome = (projectRoot: string): LintIgnoreOutcome => {
    const path = findConfigFile(projectRoot, "biome") ?? join(projectRoot, "biome.json");
    // Captured BEFORE the write, like `mergeJsonArray` — see the note there.
    const preexisting = existsSync(path);
    const text = preexisting ? readFileSync(path, "utf8") : "{}\n";
    const files = ((parseJsonc(text) ?? {}) as Record<string, unknown>)["files"] ?? {};
    const filesRecord = files as Record<string, unknown>;

    if (Array.isArray(filesRecord["ignore"])) {
        return mergeJsonArray(path, ["files", "ignore"], LUNORA_IGNORED_PATHS, "biome");
    }

    const includes = Array.isArray(filesRecord["includes"]) ? (filesRecord["includes"] as string[]) : [];
    // A negation can only subtract from what an earlier pattern matched, so an
    // empty `includes` needs `"**"` in front or the exclusions describe nothing.
    const base = includes.length === 0 ? ["**"] : includes;
    const negations = LUNORA_IGNORED_PATHS.map((entry) => `!${entry.endsWith("/") ? `${entry}**` : entry}`);
    const missing = negations.filter((pattern) => !includes.includes(pattern));

    if (missing.length === 0 && preexisting) {
        return { path, status: "unchanged", tool: "biome" };
    }

    writeFileSync(path, applyModify(text, ["files", "includes"], [...base, ...missing]), "utf8");

    return { path, status: preexisting ? "updated" : "created", tool: "biome" };
};

/** The flat-config object carrying the ignores, rendered for a config file or a paste-in snippet. */
const eslintIgnoresSnippet = (): string =>
    `{\n    // Lunora generated + derived artifacts.\n    ignores: [${LUNORA_IGNORED_PATHS.map((entry) => `"${entry.endsWith("/") ? `${entry}**` : entry}"`).join(", ")}],\n}`;

/**
 * Configure ESLint's ignores.
 *
 * Creates `eslint.config.js` when the project has none — a flat config holding
 * only the ignores is valid on its own and is meant to be extended. When one
 * already exists it is left alone and reported as `"manual"`: it is arbitrary
 * JavaScript, and rewriting a user's lint config on their behalf is not
 * something to do quietly. `.eslintignore` is never written — flat config
 * removed it, and ESLint warns about the file while ignoring its contents, so
 * creating one would leave behind something that looks like it works.
 */
const applyEslint = (projectRoot: string): LintIgnoreOutcome => {
    const existing = findConfigFile(projectRoot, "eslint");
    const snippet = eslintIgnoresSnippet();

    if (existing !== undefined) {
        const text = readFileSync(existing, "utf8");
        const status: LintIgnoreStatus = LUNORA_IGNORED_PATHS.every((entry) => text.includes(entry)) ? "unchanged" : "manual";

        return { path: existing, ...(status === "manual" ? { snippet } : {}), status, tool: "eslint" };
    }

    const path = join(projectRoot, "eslint.config.js");

    writeFileSync(
        path,
        `// Flat config. Add your own entries alongside the ignores below.\nexport default [\n    ${snippet.replaceAll("\n", "\n    ")},\n];\n`,
        "utf8",
    );

    return { path, status: "created", tool: "eslint" };
};

const WRITERS: Record<LintTool, (projectRoot: string) => LintIgnoreOutcome> = {
    biome: applyBiome,
    eslint: applyEslint,
    oxlint: applyOxlint,
    prettier: applyPrettier,
};

/**
 * Add {@link LUNORA_IGNORED_PATHS} to each tool's configuration.
 *
 * Idempotent: every writer appends only what is missing, so re-running after a
 * `lunora add` neither duplicates entries nor disturbs a project's own rules.
 * @param projectRoot The project to configure.
 * @param tools Which tools to configure — normally {@link detectLintTools}'s result, or the user's selection at `init`.
 * @returns one outcome per tool, in the order given.
 */
const applyLintIgnores = (projectRoot: string, tools: ReadonlyArray<LintTool>): LintIgnoreOutcome[] => tools.map((tool) => WRITERS[tool](projectRoot));

export { applyLintIgnores, detectLintTools, LUNORA_IGNORED_PATHS };
export type { LintIgnoreOutcome, LintIgnoreStatus, LintTool };
