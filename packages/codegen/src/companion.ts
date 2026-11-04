import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ts } from "ts-morph";

/** The binding the app's Worker reaches the companion through; the runtime advisor route reads it. */
const COMPANION_BINDING = "ADVISOR_COMPANION";

/** Every file codegen writes into the companion folder; the sweep touches nothing else, so wrangler's own `.wrangler/` survives. */
const COMPANION_FILES = ["advisor-procedures.json", "src/worker.ts", "wrangler.jsonc"] as const;

const WRANGLER_FILENAMES = ["wrangler.jsonc", "wrangler.json"];

/**
 * The parsed top-level object of the project's wrangler JSON(C) file. Parsed rather than pattern-matched so a
 * nested `"name"` (a Durable Object or Workflow binding) or a commented-out line can never be mistaken for the Worker's.
 * `undefined` when there is no JSON(C) file; throws when a file exists but is not valid, or only `wrangler.toml` exists.
 */
const readWrangler = (projectRoot: string): { config: Record<string, unknown>; path: string } | undefined => {
    for (const filename of WRANGLER_FILENAMES) {
        const path = join(projectRoot, filename);

        if (existsSync(path)) {
            const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));

            if (parsed.error !== undefined || typeof parsed.config !== "object" || parsed.config === null) {
                throw new Error(`@lunora/codegen: ${path} is not valid JSON(C), so the companion Worker's name cannot be derived`);
            }

            return { config: parsed.config as Record<string, unknown>, path };
        }
    }

    if (existsSync(join(projectRoot, "wrangler.toml"))) {
        throw new Error(
            `@lunora/codegen: ${join(projectRoot, "wrangler.toml")} is not read — the companion Worker needs wrangler.jsonc or wrangler.json to derive its name`,
        );
    }

    return undefined;
};

/** Top-level string value of `key` in the wrangler file. */
const wranglerString = (projectRoot: string, key: string): string | undefined => {
    const value = readWrangler(projectRoot)?.config[key];

    return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * The companion Worker's name: the main wrangler `name` with `-advisor` appended. A project with no wrangler
 * config at all falls back to the folder name so the name stays valid and deterministic; a config that exists
 * without a top-level `name` is an error, since guessing would deploy the companion under a name the app never chose.
 */
const companionName = (projectRoot: string): string => {
    const wrangler = readWrangler(projectRoot);

    if (wrangler === undefined) {
        return `${basename(projectRoot)}-advisor`;
    }

    const { name } = wrangler.config;

    if (typeof name !== "string" || name === "") {
        throw new Error(`@lunora/codegen: ${wrangler.path} declares no top-level "name", which the companion Worker's name is derived from`);
    }

    return `${name}-advisor`;
};

/** The folder codegen writes the companion into, under the project's lunora directory. */
const companionDirectory = (projectRoot: string, lunoraDirectory = "lunora"): string => join(projectRoot, lunoraDirectory, "_generated", "companion");

export { COMPANION_BINDING, COMPANION_FILES, companionDirectory, companionName, wranglerString };
