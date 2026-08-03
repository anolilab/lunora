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
import { dirname, join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import { readProjectDependencyNames } from "./detect-framework";
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

/**
 * Per-tool facts, in one table so adding a fifth tool is one entry rather than
 * an edit to four parallel maps that must be kept in step. `apply` is attached
 * below, after the writers are declared.
 *
 * `shadowable` marks a tool whose config REPLACES rather than merges with one
 * further up the tree — see {@link resolveConfigTarget} for why that decides
 * whether a missing config may be created.
 */
const TOOLS: Record<LintTool, { configFiles: ReadonlyArray<string>; packages: ReadonlyArray<string>; shadowable: boolean }> = {
    biome: { configFiles: ["biome.json", "biome.jsonc"], packages: ["@biomejs/biome"], shadowable: true },
    eslint: {
        configFiles: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"],
        packages: ["eslint"],
        shadowable: true,
    },
    oxlint: { configFiles: [".oxlintrc.json"], packages: ["oxlint"], shadowable: true },
    prettier: {
        // `.prettierignore` only ever ADDS exclusions and is resolved from the
        // working directory rather than by walking up, so a nested one cannot
        // disable anything an outer one enforced.
        configFiles: [
            ".prettierrc",
            ".prettierrc.json",
            ".prettierrc.js",
            ".prettierrc.mjs",
            ".prettierrc.cjs",
            "prettier.config.js",
            "prettier.config.mjs",
            "prettier.config.cjs",
        ],
        packages: ["prettier"],
        shadowable: false,
    },
};

const ALL_TOOLS = Object.keys(TOOLS) as ReadonlyArray<LintTool>;

/** The first existing config file for `tool` in `directory`, or `undefined`. */
const configFileIn = (directory: string, tool: LintTool): string | undefined =>
    TOOLS[tool].configFiles.map((name) => join(directory, name)).find((path) => existsSync(path));

/**
 * Walk up from `projectRoot` looking for `tool`'s config, stopping at the
 * repository boundary (a directory holding `.git`) or the filesystem root.
 *
 * The boundary matters: without it a lone project nested anywhere under a
 * developer's home directory could bind to an unrelated config far above it.
 */
const findConfigFileUpward = (projectRoot: string, tool: LintTool): string | undefined => {
    let directory = projectRoot;

    for (;;) {
        const found = configFileIn(directory, tool);

        if (found !== undefined) {
            return found;
        }

        if (existsSync(join(directory, ".git"))) {
            return undefined;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
};

/**
 * Where `tool`'s ignores should go, and whether the file may be created.
 *
 * The distinction exists because of monorepos. `detectLintTools` fires on a
 * declared dependency alone — deliberately — but in a workspace the dependency
 * is declared in the package while the config lives at the root. Creating a
 * fresh config in the package directory does not add ignores there, it
 * **shadows the root**: ESLint 9 stops at the first flat config it finds walking
 * up, so a package-level file containing only `ignores` and no rules silently
 * switches off everything the root enforced — and lint still exits 0. Biome and
 * oxlint replace the outer rule set the same way.
 *
 * So a config found further up is reported for the user to extend, never
 * duplicated downward. Creation is reserved for the case it was meant for: a
 * standalone project with no config anywhere above it.
 */
const resolveConfigTarget = (projectRoot: string, tool: LintTool): { action: "create" | "extend" | "report"; path: string } => {
    const local = configFileIn(projectRoot, tool);

    if (local !== undefined) {
        return { action: "extend", path: local };
    }

    // A `projectRoot` that holds `.git` IS a repository root, so nothing above it
    // belongs to this project — checked here because the upward walk starts at
    // the parent and would otherwise step straight over the boundary.
    const isRepositoryRoot = existsSync(join(projectRoot, ".git"));
    const inherited = TOOLS[tool].shadowable && !isRepositoryRoot ? findConfigFileUpward(dirname(projectRoot), tool) : undefined;

    // The canonical filename for a fresh config is the first the tool lists.
    const [preferred = ""] = TOOLS[tool].configFiles;

    return inherited === undefined ? { action: "create", path: join(projectRoot, preferred) } : { action: "report", path: inherited };
};

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
    const packages = readProjectDependencyNames(projectRoot);
    // A `prettier` key in package.json IS a prettier config, and plenty of
    // projects configure it there instead of a dotfile. Kept local rather than
    // pushed into the shared dependency reader — it is a prettier fact, not a
    // dependency fact.
    const configuresPrettierInManifest = (): boolean => {
        try {
            return (JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as Record<string, unknown>)["prettier"] !== undefined;
        } catch {
            return false;
        }
    };

    return ALL_TOOLS.filter(
        (tool) =>
            TOOLS[tool].packages.some((name) => packages.has(name)) ||
            configFileIn(projectRoot, tool) !== undefined ||
            (tool === "prettier" && configuresPrettierInManifest()),
    );
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

/** The ignore entries as a config fragment, for a config this module will not edit itself. */
const jsonIgnoresSnippet = (pointer: string, values: ReadonlyArray<string>): string => `"${pointer}": [${values.map((value) => `"${value}"`).join(", ")}]`;

const biomeIgnoresSnippet = (): string =>
    jsonIgnoresSnippet(
        "files.includes",
        LUNORA_IGNORED_PATHS.map((entry) => `!${entry.endsWith("/") ? `${entry}**` : entry}`),
    );

/** Create or extend `.oxlintrc.json`'s `ignorePatterns` (gitignore-style, per oxlint's schema). */
const applyOxlint = (projectRoot: string): LintIgnoreOutcome => {
    const { action, path } = resolveConfigTarget(projectRoot, "oxlint");

    // Same shadowing rule as biome/eslint: a nested `.oxlintrc.json` replaces the
    // rule set an ancestor config declared rather than merging with it.
    if (action === "report") {
        return { path, snippet: jsonIgnoresSnippet("ignorePatterns", LUNORA_IGNORED_PATHS), status: "manual", tool: "oxlint" };
    }

    return mergeJsonArray(path, ["ignorePatterns"], LUNORA_IGNORED_PATHS, "oxlint");
};

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
    const { action, path } = resolveConfigTarget(projectRoot, "biome");

    // Inherited from an ancestor: extending it would reach outside the project we
    // were asked about, and copying it down would shadow it. Report instead.
    if (action === "report") {
        return { path, snippet: biomeIgnoresSnippet(), status: "manual", tool: "biome" };
    }

    // Captured BEFORE the write, like `mergeJsonArray` — see the note there.
    const preexisting = action === "extend";
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
    const { action, path: targetPath } = resolveConfigTarget(projectRoot, "eslint");
    const snippet = eslintIgnoresSnippet();

    if (action !== "create") {
        const text = readFileSync(targetPath, "utf8");
        const status: LintIgnoreStatus = LUNORA_IGNORED_PATHS.every((entry) => text.includes(entry)) ? "unchanged" : "manual";

        return { path: targetPath, ...(status === "manual" ? { snippet } : {}), status, tool: "eslint" };
    }

    // `.mjs`, not `.js`: the body is ESM, and a project without `"type": "module"`
    // in its manifest would have Node load a `.js` config as CommonJS and ESLint
    // die on `Unexpected token 'export'`. The `.mjs` extension is correct either
    // way, so it needs no manifest inspection to stay right.
    const path = join(projectRoot, "eslint.config.mjs");

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
