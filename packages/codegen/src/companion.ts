import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The binding the app's Worker reaches the companion through; the runtime advisor route reads it. */
const COMPANION_BINDING = "ADVISOR_COMPANION";

const WRANGLER_FILENAMES = ["wrangler.jsonc", "wrangler.json"];

/** Top-level string value of `key` in a wrangler file; the first match wins, which is the top level in every real config. */
const wranglerString = (projectRoot: string, key: string): string | undefined => {
    for (const filename of WRANGLER_FILENAMES) {
        const path = join(projectRoot, filename);

        if (existsSync(path)) {
            return new RegExp(String.raw`"${key}"\s*:\s*"([^"]+)"`).exec(readFileSync(path, "utf8"))?.[1];
        }
    }

    return undefined;
};

/**
 * The companion Worker's name: the main wrangler `name` with `-advisor` appended, falling back to the project
 * folder name so a project without a wrangler config still gets a valid, deterministic name.
 */
const companionName = (projectRoot: string): string => `${wranglerString(projectRoot, "name") ?? basename(projectRoot)}-advisor`;

/** The folder codegen writes the companion into, under the default lunora directory. Deploy and dev use the default. */
const companionDirectory = (projectRoot: string): string => join(projectRoot, "lunora", "_generated", "companion");

export { COMPANION_BINDING, companionDirectory, companionName, wranglerString };
