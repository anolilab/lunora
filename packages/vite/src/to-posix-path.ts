import { sep } from "node:path";

/**
 * Forward slashes, whatever the host separator, so a metafile key reads the same on Windows as on POSIX.
 * The separator is a parameter so a `\`-separated path can be checked on a POSIX host.
 */
const toPosixPath = (path: string, separator: string = sep): string => path.split(separator).join("/");

export default toPosixPath;
