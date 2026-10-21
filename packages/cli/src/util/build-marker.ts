import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import { resolveTargetOrThrow } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { frameworkBuildFor } from "../commands/build/framework-build";

/**
 * What `lunora build` leaves behind for `lunora deploy --prebuilt`. The deploy trusts the client output on disk, so this
 * records what that output was built from, and the guard refuses a deploy whose sources, target, environment or output
 * files no longer match it.
 */
interface BuildMarker {
    /** Whether the build ran its client build. `false` cannot satisfy a deploy whose project needs one. */
    clientBuild: boolean;
    /** `CLOUDFLARE_ENV` the build saw. Absent for the default environment. */
    environment?: string;
    /** Project-relative paths the build wrote into the tree (`--out-dir`, `--emit-bindings`); left out of the fingerprint. */
    excluded: string[];
    /** Content fingerprint of the sources the build read (see {@link sourceFingerprint}). */
    fingerprint: string;
    /** Project-relative client-output paths wrangler reads for that environment. */
    outputs: string[];
    /** The resolved deploy target the build was made for. */
    target: string;
}

const MARKER_PATH = join(".lunora", "build-marker.json");

/**
 * Directories a source fingerprint never reads: dependencies, VCS state, and build output. Applied to both the git listing and
 * the no-git walk, so the two agree on what is a source.
 */
const EXCLUDED_PREFIXES = [".astro/", ".git/", ".lunora/", ".next/", ".nuxt/", ".output/", ".svelte-kit/", ".wrangler/", "build/", "dist/", "node_modules/"];

/** Directories pruned by name at any depth during the no-git walk. */
const WALK_PRUNED_NAMES = new Set([".git", "node_modules"]);

interface WranglerAssets {
    assets?: { directory?: unknown };
    env?: Record<string, { assets?: { directory?: unknown } } | undefined>;
}

/** Code-unit order, not `localeCompare`: the sort must not depend on the machine's locale, or two checkouts hash differently. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : 1);

const environmentFrom = (env: string | undefined): string | undefined => [env, process.env.CLOUDFLARE_ENV].find((value) => value !== undefined && value !== "");

const isExcluded = (path: string, extra: ReadonlyArray<string>): boolean =>
    EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) || extra.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

/** Tracked and untracked-but-not-ignored files, relative to `cwd`, or `undefined` when `cwd` is not inside a git work tree. */
const gitSourceFiles = (cwd: string): string[] | undefined => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH (install location varies); args are fixed and no shell is involved
        const output = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });

        return output.split("\0").filter((path) => path !== "");
    } catch {
        return undefined;
    }
};

const walkSourceFiles = (cwd: string, directory = ""): string[] => {
    const files: string[] = [];

    for (const entry of readdirSync(join(cwd, directory), { withFileTypes: true })) {
        if (WALK_PRUNED_NAMES.has(entry.name)) {
            continue;
        }

        const path = directory === "" ? entry.name : `${directory}/${entry.name}`;

        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(cwd, path));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }

    return files;
};

/**
 * Content hash of the project's sources: sorted project-relative POSIX paths and the bytes of each file. No mtimes and no
 * absolute paths, so the same tree hashes the same in CI's checkout as on a laptop. A file that cannot be read (a deleted
 * tracked file, a submodule directory) hashes as a fixed marker, so a deletion still changes the result.
 *
 * `extra` lists project-relative paths the build itself writes (`--out-dir`, `--emit-bindings`) that a fresh checkout will not
 * contain, so they stay out of the hash.
 */
const sourceFingerprint = (cwd: string, extra: ReadonlyArray<string> = []): string => {
    const listed = gitSourceFiles(cwd) ?? walkSourceFiles(cwd);
    const paths = listed.filter((path) => !isExcluded(path, extra)).toSorted(byCodeUnit);
    const hash = createHash("sha256");

    for (const path of paths) {
        let content: Buffer | string;

        try {
            content = readFileSync(join(cwd, path));
        } catch {
            content = "\0unreadable";
        }

        hash.update(`${path}\0${String(Buffer.byteLength(content))}\0`).update(content);
    }

    return hash.digest("hex");
};

const relativeInProject = (cwd: string, path: string): string | undefined => {
    const relativePath = toPosix(relative(cwd, resolve(cwd, path)));

    return relativePath === "" || relativePath.startsWith("..") ? undefined : relativePath;
};

/**
 * Client-output paths wrangler reads for `environment`: the Vite redirect (`.wrangler/deploy/config.json`), the config it
 * points at and that config's assets, plus `assets.directory` (the environment's, when it sets one, else the top level's).
 * The assets directory is recorded whether or not it exists yet, so a declared output a build failed to write is refused at
 * deploy time. The redirect is only read when it exists; a build that skipped its client build is refused by `clientBuild`.
 */
const clientOutputsFor = (cwd: string, environment: string | undefined): string[] => {
    const outputs: string[] = [];
    const redirectPath = join(cwd, ".wrangler", "deploy", "config.json");

    if (existsSync(redirectPath)) {
        outputs.push(toPosix(relative(cwd, redirectPath)));

        const configPath = readWranglerJsonc<{ configPath?: unknown }>(redirectPath).parsed?.configPath;

        if (typeof configPath === "string") {
            const redirected = resolve(dirname(redirectPath), configPath);

            outputs.push(toPosix(relative(cwd, redirected)));

            const directory = readWranglerJsonc<{ assets?: { directory?: unknown } }>(redirected).parsed?.assets?.directory;

            if (typeof directory === "string") {
                outputs.push(toPosix(relative(cwd, resolve(dirname(redirected), directory))));
            }
        }
    }

    const wranglerPath = findWranglerFile(cwd);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerAssets>(wranglerPath).parsed;
    const directory = (environment === undefined ? undefined : wrangler?.env?.[environment]?.assets?.directory) ?? wrangler?.assets?.directory;

    if (typeof directory === "string") {
        outputs.push(toPosix(relative(cwd, resolve(cwd, directory))));
    }

    return outputs;
};

const readBuildMarker = (cwd: string): BuildMarker | undefined => {
    try {
        return JSON.parse(readFileSync(join(cwd, MARKER_PATH), "utf8")) as BuildMarker;
    } catch {
        return undefined;
    }
};

/** Deletes any marker, so a build that fails part-way cannot leave one that looks valid. */
const clearBuildMarker = (cwd: string): void => {
    rmSync(join(cwd, MARKER_PATH), { force: true });
};

interface WriteBuildMarkerOptions {
    /** Whether the client build ran for this build (see `clientBuildRuns`). */
    clientBuild: boolean;
    cwd: string;
    /** The resolved deploy target. */
    target: string;
    /** The `--out-dir` and `--emit-bindings` paths, as given (absolute or relative to `cwd`). */
    written: ReadonlyArray<string | undefined>;
}

/**
 * Record a successful build. Call it after the build's wrangler rollback has run, because the fingerprint has to describe the
 * sources as they are after `lunora build`, not as they were before it rewrote generated files.
 */
const writeBuildMarker = ({ clientBuild, cwd, target, written }: WriteBuildMarkerOptions): void => {
    const environment = environmentFrom(undefined);
    const excluded = written
        .filter((path): path is string => path !== undefined)
        .map((path) => relativeInProject(cwd, path))
        .filter((path): path is string => path !== undefined);
    const marker: BuildMarker = {
        clientBuild,
        environment,
        excluded,
        fingerprint: sourceFingerprint(cwd, excluded),
        outputs: clientOutputsFor(cwd, environment),
        target,
    };

    mkdirSync(join(cwd, ".lunora"), { recursive: true });
    writeFileSync(join(cwd, MARKER_PATH), `${JSON.stringify(marker, undefined, 4)}\n`, "utf8");
};

const describeEnvironment = (environment: string | undefined): string => (environment === undefined ? "the default environment" : `environment ${environment}`);

interface BuildMarkerCheck {
    cwd: string;
    /** `--env` for this deploy; `CLOUDFLARE_ENV` is used when it is absent, as wrangler does. */
    env?: string;
    /** `--target` for this deploy, if given. */
    target?: string;
}

/**
 * The reason `deploy --prebuilt` must not ship what is on disk, or `undefined` when it may. A project that needs no client build
 * (a plain Worker) is never refused, so `prepare` then `deploy --prebuilt` keeps working for it.
 */
const buildMarkerRefusal = ({ cwd, env, target }: BuildMarkerCheck): string | undefined => {
    const environment = environmentFrom(env);

    if (frameworkBuildFor(cwd, environment) === undefined) {
        return undefined;
    }

    const marker = readBuildMarker(cwd);

    if (marker === undefined) {
        return "`--prebuilt` ships the client output that `lunora build` produced, and none is recorded for this project. Run `lunora build` first; `lunora prepare` builds no client output.";
    }

    if (marker.fingerprint !== sourceFingerprint(cwd, marker.excluded)) {
        return "sources changed since `lunora build`; run `lunora build` again before `deploy --prebuilt`.";
    }

    let deployTarget: string;

    try {
        deployTarget = resolveTargetOrThrow(cwd, target);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }

    if (!marker.clientBuild) {
        return "`lunora build` ran without its client build (`--no-framework-build`, or no client build for its environment), so there is no client output to ship. Run `lunora build` again with the client build enabled.";
    }

    if (marker.target !== deployTarget) {
        return `the client output was built for target ${marker.target}, and this deploy targets ${deployTarget}; run \`lunora build\` again for it.`;
    }

    if (marker.environment !== environment) {
        const fix = environment === undefined ? "run `lunora build` without CLOUDFLARE_ENV" : `run \`CLOUDFLARE_ENV=${environment} lunora build\``;

        return `the client output was built for ${describeEnvironment(marker.environment)}, and this deploy targets ${describeEnvironment(environment)}; ${fix}.`;
    }

    const missing = marker.outputs.filter((path) => !existsSync(join(cwd, path)));

    if (missing.length > 0) {
        return `the client output recorded by \`lunora build\` is missing: ${missing.join(", ")}. Upload the build's output directories to this job, or run \`lunora build\` here.`;
    }

    return undefined;
};

export { buildMarkerRefusal, clearBuildMarker, readBuildMarker, sourceFingerprint, writeBuildMarker };
export type { BuildMarker };
