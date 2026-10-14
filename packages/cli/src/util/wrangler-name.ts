/**
 * Read the Worker `name` from the project's wrangler config, or `undefined`
 * when there is no config / no name. Shared by `link`, the deploy summary, and
 * the deploy auto-link so the lookup lives in exactly one place.
 */
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

interface WranglerNameShape {
    name?: unknown;
}

const readWranglerName = (cwd: string): string | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerNameShape>(wranglerPath);

    return typeof parsed?.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
};

export default readWranglerName;
