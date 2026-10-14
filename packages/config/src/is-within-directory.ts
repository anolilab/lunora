import { isAbsolute, relative, sep } from "node:path";

/**
 * Whether `file` lies under `directory` (both absolute, in the host's path
 * style). Resolved with `relative()` rather than a string prefix, so a Windows
 * path's `\` separators and a sibling sharing the prefix (`lunora-old/`) are
 * both handled.
 */
const isWithinDirectory = (file: string, directory: string): boolean => {
    const path = relative(directory, file);

    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export default isWithinDirectory;
