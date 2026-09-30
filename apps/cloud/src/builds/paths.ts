/**
 * Monorepo build settings: a project's root directory and the paths a push has
 * to touch before it rebuilds.
 *
 * Pure so it runs in three places that must agree — the settings mutation that
 * stores them, the push recorder that decides whether to build, and the Studio
 * form that validates as the user types. The build box re-validates the root
 * directory itself (`containers/build/paths.mjs`) because it trusts nothing
 * that arrives over HTTP, and it is zero-dependency so it cannot import this.
 */
import picomatch from "picomatch/posix";

export const MAX_ROOT_DIRECTORY_LENGTH = 256;
export const MAX_WATCH_PATHS = 20;
export const MAX_WATCH_PATH_LENGTH = 256;

/** Beyond this many changed files a push is treated as "cannot tell" and builds. */
export const MAX_CHANGED_FILES = 1000;

/** The lockfiles the build box recognises. A change to one rebuilds, whatever the watch paths say. */
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"] as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Reject what every repo-relative path must not contain. Returns the problem,
 * or `null` when the value is clean.
 */
const pathProblem = (value: string, label: string, maxLength: number): null | string => {
    if (value.length > maxLength) {
        return `${label} must be at most ${String(maxLength)} characters`;
    }

    if (CONTROL_CHARACTERS.test(value) || value.includes("\\")) {
        return `${label} must not contain backslashes or control characters`;
    }

    if (value.startsWith("/")) {
        return `${label} must be relative to the repository root (no leading "/")`;
    }

    if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        return `${label} must be a normalized path: no "..", "." or empty segments`;
    }

    return null;
};

/**
 * Normalize a root directory, or throw with the reason.
 *
 * `""`, `"."` and `"./"` all mean the repository root and come back as `""`;
 * one trailing slash is forgiven. Everything else must already be normalized —
 * `apps/../web` is refused rather than resolved, so what is stored is what the
 * user sees and what the build box checks.
 */
export const normalizeRootDirectory = (input: string): string => {
    let value = input.trim();

    if (value === "" || value === "." || value === "./") {
        return "";
    }

    if (value.endsWith("/")) {
        value = value.slice(0, -1);
    }

    const problem = pathProblem(value, "root directory", MAX_ROOT_DIRECTORY_LENGTH);

    if (problem !== null) {
        throw new Error(problem);
    }

    return value;
};

/**
 * Validate a watch-path list, or throw with the reason. Returns the trimmed
 * list with empty lines dropped.
 *
 * Negations (`!foo`) are refused: a list is "rebuild if ANY pattern matches",
 * and a negated entry inside that reads as an exclusion while matching almost
 * every file — the opposite of what whoever typed it meant.
 */
export const normalizeWatchPaths = (input: ReadonlyArray<string>): string[] => {
    const patterns = input.map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");

    if (patterns.length > MAX_WATCH_PATHS) {
        throw new Error(`at most ${String(MAX_WATCH_PATHS)} watch paths`);
    }

    for (const pattern of patterns) {
        if (pattern.startsWith("!")) {
            throw new Error(`watch path "${pattern}": negated patterns are not supported`);
        }

        const problem = pathProblem(pattern, `watch path "${pattern}"`, MAX_WATCH_PATH_LENGTH);

        if (problem !== null) {
            throw new Error(problem);
        }

        try {
            picomatch(pattern);
        } catch {
            throw new Error(`watch path "${pattern}" is not a valid glob`);
        }
    }

    return patterns;
};

/**
 * The patterns a push is checked against: the project's own watch paths (or
 * everything under its root directory), plus every lockfile between the
 * repository root and the root directory — the build box installs at the
 * nearest one of those, so a dependency bump there changes the build even when
 * no file under the app did.
 */
export const effectiveWatchPaths = (rootDirectory: string | undefined, watchPaths: ReadonlyArray<string> | undefined): string[] => {
    const root = rootDirectory ?? "";
    const own = watchPaths !== undefined && watchPaths.length > 0 ? [...watchPaths] : [root === "" ? "**" : `${root}/**`];
    const segments = root === "" ? [] : root.split("/");
    const lockfiles: string[] = [];

    for (let depth = 0; depth <= segments.length; depth += 1) {
        const prefix = segments.slice(0, depth).join("/");

        for (const lockfile of LOCKFILES) {
            lockfiles.push(prefix === "" ? lockfile : `${prefix}/${lockfile}`);
        }
    }

    return [...new Set([...own, ...lockfiles])];
};

/** What a push can tell us about the files it changed. */
export type PushChanges = { files: string[] } | { unknown: string };

export type BuildDecision = { build: false; reason: string } | { build: true; reason: string };

/**
 * Should this push build?
 *
 * Fails OPEN: when the push cannot prove which files it changed, it builds.
 * A skipped deploy that should have happened is invisible until someone
 * notices production is stale; a redundant build costs a few minutes.
 */
export const decideBuild = (changes: PushChanges, rootDirectory: string | undefined, watchPaths: ReadonlyArray<string> | undefined): BuildDecision => {
    if ("unknown" in changes) {
        return { build: true, reason: `building without a path check: ${changes.unknown}` };
    }

    const patterns = effectiveWatchPaths(rootDirectory, watchPaths);

    if (patterns.includes("**")) {
        return { build: true, reason: "the project watches the whole repository" };
    }

    const isMatch = picomatch(patterns, { dot: true });
    const hit = changes.files.find((file) => isMatch(file));

    if (hit !== undefined) {
        return { build: true, reason: `${hit} changed` };
    }

    const watched = watchPaths !== undefined && watchPaths.length > 0 ? watchPaths.join(", ") : `${rootDirectory ?? ""}/`;

    return { build: false, reason: `no changes under ${watched} or the lockfile (${String(changes.files.length)} files changed)` };
};
