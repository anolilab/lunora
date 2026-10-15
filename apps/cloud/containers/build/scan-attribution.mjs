/**
 * Where a finding's code came from: the bundle's sourcemap (located, size- and
 * heap-capped, then decoded only for the lines asked for), else esbuild's
 * `// <path>` region comments, else the bundle itself — and whether that
 * origin is code the tenant wrote at all.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { MIB, ScanError } from "./scan-budget.mjs";

/** @typedef {import("./scan-budget.mjs").ScanLimits} ScanLimits */

// eslint-disable-next-line no-secrets/no-secrets -- the base64 alphabet, not a credential
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Base64 digit value by character code; -1 for anything that is not one. */
const BASE64_VALUE = new Int8Array(128).fill(-1);

for (const [value, character] of [...BASE64].entries()) {
    BASE64_VALUE[character.codePointAt(0) ?? 0] = value;
}

const COMMA = 44;
const SEMICOLON = 59;

/**
 * Decode the segments of a v3 sourcemap's `mappings` for the generated lines
 * asked for. Source and original-line fields are deltas across the whole
 * string, so every segment is decoded; only the wanted lines are kept.
 *
 * One pass over character codes, decoding base64 VLQ in place (five bits per
 * digit, continuation flagged by 32, sign in the lowest bit), with no
 * intermediate strings or arrays: a map of tens of MiB holds millions of
 * segments, and both the time and the memory budget pay for every copy.
 * @param {string} mappings The `mappings` string.
 * @param {Set<number>} wanted Generated lines (1-based) to keep.
 * @param {() => void} check The deadline check.
 * @returns {Map<number, number[][]>} Line → its `[generatedColumn, source, originalLine]` segments, in column order.
 */
const decodeMappings = (mappings, wanted, check) => {
    const lines = new Map();
    let source = 0;
    let originalLine = 0;
    let line = 1;
    let generatedColumn = 0;
    let kept = [];
    // The segment being read: its fields so far, and its source/line deltas.
    let fields = 0;
    let sourceDelta = 0;
    let lineDelta = 0;
    let value = 0;
    let scale = 1;

    const endSegment = () => {
        if (fields >= 4) {
            source += sourceDelta;
            originalLine += lineDelta;

            if (wanted.has(line)) {
                kept.push([generatedColumn, source, originalLine]);
            }
        }

        fields = 0;
    };
    const endLine = () => {
        if (kept.length > 0) {
            lines.set(line, kept);
            kept = [];
        }

        line += 1;
        generatedColumn = 0;
        check();
    };
    const pushField = (decoded) => {
        switch (fields) {
            case 0: {
                generatedColumn += decoded;
                break;
            }
            case 1: {
                sourceDelta = decoded;
                break;
            }
            case 2: {
                lineDelta = decoded;
                break;
            }
            default:
            // The original column and name index: decoded, not needed.
        }

        fields += 1;
    };

    const readDigit = (code) => {
        const digit = code < 128 ? BASE64_VALUE[code] : -1;

        if (digit < 0) {
            throw new ScanError("the bundle's sourcemap has malformed mappings");
        }

        // Arithmetic rather than bit operators: the same VLQ, without 32-bit overflow on a long digit run.
        value += (digit % 32) * scale;

        if (digit >= 32) {
            scale *= 32;

            return;
        }

        pushField(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
        value = 0;
        scale = 1;
    };

    for (let index = 0; index < mappings.length; index += 1) {
        const code = mappings.codePointAt(index) ?? 0;

        switch (code) {
            case COMMA: {
                endSegment();
                break;
            }
            case SEMICOLON: {
                endSegment();
                endLine();
                break;
            }
            default: {
                readDigit(code);
            }
        }
    }

    endSegment();

    if (kept.length > 0) {
        lines.set(line, kept);
    }

    return lines;
};

/**
 * Where a finding's code came from, relative to the repository — or why it is
 * none of the tenant's business.
 * @typedef {{ file: string, line: number, location: "bundle" | "source" } | { dropped: true }} Attribution
 */

/** Path segments whose files the tenant did not write: dependencies and generated output. */
const FOREIGN_SEGMENTS = new Set([".lunora", ".wrangler", "node_modules"]);

/**
 * A repo-relative POSIX path for `absolute`, or `undefined` when it lies
 * outside the repository or in code the tenant did not write.
 * @param {string} repo Real path of the extracted repo.
 * @param {string} absolute An absolute path.
 * @returns {string | undefined} The path to report.
 */
const tenantPath = (repo, absolute) => {
    const path = relative(repo, absolute);

    if (path === "" || path.startsWith("..") || isAbsolute(path)) {
        return undefined;
    }

    const segments = path.split(sep);

    return segments.some((segment) => FOREIGN_SEGMENTS.has(segment)) ? undefined : segments.join("/");
};

/** A `scheme:` prefix — a URL, which names nothing on this disk. */
const URL_SCHEME = /^[a-z][\w+.-]*:/iu;

/** The trailing `sourceMappingURL` comment of a module. */
const SOURCE_MAPPING_URL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/u;

/**
 * A sourcemap `sources` entry as an absolute path. Resolved against the map's
 * own directory, ignoring `sourceRoot`: wrangler writes `sourceRoot: "out"`
 * beside sources already relative to the map, and honouring both points every
 * path one directory too deep. Only plain paths and `file:` URLs resolve.
 * @param {string} mapDirectory Directory holding the map.
 * @param {unknown} source The `sources` entry.
 * @returns {string | undefined} The path, or `undefined` for anything else.
 */
const sourcePath = (mapDirectory, source) => {
    if (typeof source !== "string" || source === "") {
        return undefined;
    }

    if (source.startsWith("file://")) {
        try {
            return fileURLToPath(source);
        } catch {
            return undefined;
        }
    }

    return URL_SCHEME.test(source) ? undefined : resolve(mapDirectory, source);
};

/**
 * Where the bundle's sourcemap is, without reading it: the first candidate
 * that is a regular file in the module's own (real) directory.
 * @param {string} bundlePath Path of the module.
 * @param {string} code The module's source.
 * @returns {Promise<{ path: string, size: number } | undefined>} The map's real path and size.
 */
const locateSourcemap = async (bundlePath, code) => {
    const directory = await realpath(dirname(bundlePath));
    const named = SOURCE_MAPPING_URL.exec(code.slice(-4096))?.[1];
    const candidates = [
        () => `${bundlePath}.map`,
        // Built lazily, per candidate: a malformed escape (`%E0%A4%A`) is the
        // tenant's to write and must cost this candidate, not the whole scan.
        ...(named !== undefined && !named.includes(":") ? [() => join(directory, decodeURIComponent(named))] : []),
    ];

    for (const candidate of candidates) {
        try {
            // eslint-disable-next-line no-await-in-loop -- at most two candidates, first one wins
            const path = await realpath(candidate());
            // eslint-disable-next-line no-await-in-loop -- see above
            const info = await stat(path);

            // A regular file only: a FIFO (or a device) planted at the map's
            // path would block the read forever and hang the build.
            if (dirname(path) === directory && info.isFile()) {
                return { path, size: info.size };
            }
        } catch {
            // Not there, or not decodable: the next candidate.
        }
    }

    return undefined;
};

/**
 * The bundle's sourcemap: `<module>.map` beside it, else the file a relative
 * `sourceMappingURL` names — only when it resolves inside the module's own
 * directory, because the module is tenant output and must not steer this read
 * anywhere else. Size-capped before it is read.
 *
 * Containment is checked on real paths, but `sources` resolve against the
 * directory as the bundler was given it: esbuild writes them relative to that
 * spelling, so through a symlinked out-dir the real path is the wrong base.
 * @param {string} bundlePath Path of the module.
 * @param {string} code The module's source.
 * A map over its size cap, one the free heap cannot hold, or one that is not
 * JSON is not read (or not used): the scan goes on without it and says so.
 * @param {ScanLimits} limits The caps.
 * @param {number} heapBudget Heap bytes left for the map once the bundle's share is set aside.
 * @returns {Promise<{ note?: string, sourcemap?: { directory: string, map: { mappings: string, sources: unknown[] } } }>} The parsed map and the directory its sources resolve against, or why there is none.
 */
const readSourcemap = async (bundlePath, code, limits, heapBudget) => {
    const found = await locateSourcemap(bundlePath, code);

    if (found === undefined) {
        return {};
    }

    const size = `${(found.size / MIB).toFixed(1)} MiB`;

    if (found.size > limits.maxMapBytes) {
        return { note: `the sourcemap is ${size}, over the ${String(limits.maxMapBytes / MIB)} MiB the scan reads; findings are placed by bundle line only` };
    }

    if (found.size * limits.heapBytesPerMapByte > heapBudget) {
        return { note: `the sourcemap (${size}) does not fit in the memory left for the scan; findings are placed by bundle line only` };
    }

    let map;

    try {
        map = JSON.parse(await readFile(found.path, "utf8"));
    } catch {
        return { note: "the sourcemap is not JSON; findings are placed by bundle line only" };
    }

    // Index maps (`sections`) are not produced by esbuild; they fall back like no map.
    return map?.version === 3 && Array.isArray(map.sources) && typeof map.mappings === "string" ? { sourcemap: { directory: dirname(bundlePath), map } } : {};
};

/**
 * Attribute positions through a sourcemap.
 * @param {{ directory: string, map: { mappings: string, sources: unknown[] } }} sourcemap The parsed map.
 * @param {string} repo Real path of the extracted repo.
 * @param {Set<number>} lines Generated lines that need answers.
 * @param {() => void} check The deadline check.
 * @returns {(position: { column: number, line: number }) => Attribution} The attributor.
 */
const sourcemapAttributor = (sourcemap, repo, lines, check) => {
    const segments = decodeMappings(sourcemap.map.mappings, lines, check);

    return ({ column, line }) => {
        const onLine = segments.get(line);

        if (onLine === undefined) {
            return { dropped: true };
        }

        // The segment covering the column; a statement esbuild indented starts
        // before its line's first mapping, which then answers for it.
        const segment = onLine.findLast(([generatedColumn]) => generatedColumn <= column) ?? onLine[0];
        const absolute = sourcePath(sourcemap.directory, sourcemap.map.sources[segment[1]]);
        const file = absolute === undefined ? undefined : tenantPath(repo, absolute);

        return file === undefined ? { dropped: true } : { file, line: segment[2] + 1, location: "source" };
    };
};

/** An esbuild region comment's path: no spaces, ends in a script extension. */
const REGION_PATH = /^[\w@.~+/-]+\.[cm]?[jt]sx?$/u;

/**
 * Attribute positions by esbuild's `// <path>` region comments when there is no
 * sourcemap: the nearest region comment above a line names its input, relative
 * to the directory `lunora build` ran in. The line reported is the bundle's.
 * @param {{ line: number, text: string }[]} comments Column-0 line comments, in order.
 * @param {string} project Real path of the project directory.
 * @param {string} repo Real path of the extracted repo.
 * @param {string} bundleFile The bundle's repo-relative path, for findings no region names.
 * @returns {(position: { column: number, line: number }) => Attribution} The attributor.
 */
const regionAttributor = (comments, project, repo, bundleFile) => {
    const regions = comments.filter((comment) => REGION_PATH.test(comment.text));

    return ({ line }) => {
        const region = regions.findLast((comment) => comment.line < line);

        if (region === undefined) {
            return { file: bundleFile, line, location: "bundle" };
        }

        const file = tenantPath(repo, resolve(project, region.text));

        return file === undefined ? { dropped: true } : { file, line, location: "bundle" };
    };
};

export { decodeMappings, readSourcemap, regionAttributor, sourcemapAttributor };
