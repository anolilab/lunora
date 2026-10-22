import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The absolute path with symlinks resolved, so two spellings of one directory compare equal. A path that does not exist yet
 * resolves through its nearest existing ancestor, since the CLI and the plugin often name a `.lunora` directory before creating it.
 */
const canonicalPath = (path: string): string => {
    const absolute = resolve(path);

    try {
        return realpathSync.native(absolute);
    } catch {
        const parent = dirname(absolute);

        return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
    }
};

export default canonicalPath;
