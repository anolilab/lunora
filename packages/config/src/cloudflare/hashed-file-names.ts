/**
 * Whether every file a build left in its hashed directory carries a content hash, judged by the file-name patterns
 * the bundler names its output with. The patterns alone do not cover a plugin's `emitFile({ fileName })`, which
 * names a file as it likes, so the check reads the files the build actually wrote.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PATTERN_TOKEN = /\[(name|hash|extname|ext|format)(?::(\d+))?\]/gu;
const REGEX_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const SOURCE_MAP_SUFFIX = /\.map$/u;

/** Rollup's and Rolldown's default `[hash]` length. */
const DEFAULT_HASH_LENGTH = 8;

const escaped = (text: string): string => text.replaceAll(REGEX_SPECIAL, String.raw`\$&`);

/**
 * A file-name pattern as a test for the names it produces: `[hash]` (or `[hash:n]`) as exactly that many base64url
 * characters, `[name]` as any run, the others as any run within one path segment. A fixed name matches none of them.
 */
const patternTest = (pattern: string): RegExp => {
    let source = "";
    let last = 0;

    for (const match of pattern.matchAll(PATTERN_TOKEN)) {
        source += escaped(pattern.slice(last, match.index));

        const [, token, length] = match;

        switch (token) {
            case "extname": {
                source += String.raw`(?:\.[^/]+)?`;
                break;
            }
            case "hash": {
                source += String.raw`[\w-]{${length ?? String(DEFAULT_HASH_LENGTH)}}`;
                break;
            }
            case "name": {
                // Rollup's `[name]` keeps an entry's own slashes (`pages/about`).
                source += ".*";
                break;
            }
            default: {
                source += "[^/]*";
            }
        }

        last = match.index + match[0].length;
    }

    return new RegExp(`^${source}${escaped(pattern.slice(last))}$`, "u");
};

/** The files under `directory`, as paths relative to `root` with `/` separators. */
const filesUnder = (root: string, directory: string): string[] => {
    try {
        return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
    } catch {
        return [];
    }
};

/**
 * Whether every file under `outputDirectory/directory` has a name one of `patterns` (relative to `outputDirectory`)
 * gives it. A source map is named after its file (`index-Ab12Cd34.js.map`), so it is judged by that name.
 */
const filesCarryHash = (outputDirectory: string, directory: string, patterns: ReadonlyArray<string>): boolean => {
    const tests = patterns.map((pattern) => patternTest(pattern));

    return filesUnder(outputDirectory, directory).every((file) => tests.some((test) => test.test(file.replace(SOURCE_MAP_SUFFIX, ""))));
};

export default filesCarryHash;
