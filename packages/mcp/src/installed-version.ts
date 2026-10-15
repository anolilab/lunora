import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version of the installed `@lunora/mcp` manifest, read at call time, or
 * `undefined` when it cannot be resolved.
 *
 * Node-only: the bundled `package.json` constant in `server.ts` is stamped at
 * build time, BEFORE semantic-release bumps the manifest, so it lags one
 * release behind. The installed manifest is exact.
 */
const installedVersion = (): string | undefined => {
    // Walk up from this module's directory: the bundler emits code into shared-chunk
    // subdirectories whose depth isn't fixed, so a relative `../package.json` is unreliable.
    let directory = dirname(fileURLToPath(import.meta.url));

    for (let depth = 0; depth < 8; depth += 1) {
        try {
            const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };

            if (manifest.name === "@lunora/mcp" && typeof manifest.version === "string" && manifest.version.length > 0) {
                return manifest.version;
            }
        } catch {
            // No readable package.json at this level; keep climbing.
        }

        const parent = dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    return undefined;
};

export default installedVersion;
