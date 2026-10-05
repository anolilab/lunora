/**
 * Where in the extracted source a build installs and runs (monorepo support).
 *
 * Split out of `server.mjs` so the path logic — the part a tenant steers with
 * a project setting — is unit-testable without booting the server. Same rule
 * as the server: zero dependencies, because this image runs untrusted code.
 *
 * Three directories matter, and every one is contained in the extracted repo.
 * The repo is the `mkdtemp` directory the tarball was extracted into. The
 * project is `<repo>/<rootDirectory>`, where `lunora build` runs and its output
 * is collected. The workspace root is the nearest directory at or above the
 * project that holds a lockfile, never above the repo — where dependencies are
 * installed.
 */
import { access, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * An error whose message is written FOR the person who pushed the commit.
 *
 * The distinction matters because this server's replies end up in `buildLogs`,
 * which tenants read in the Studio. "no lockfile found" and "your project does
 * not depend on the Lunora CLI" are the whole point — a build box that hid them
 * would leave someone staring at a red build with no cause. But an unexpected
 * `ENOENT /workspace/build-a1b2/node_modules/…` is not their problem, is not
 * actionable, and describes this container's insides to someone outside it.
 *
 * So a `BuildError` is echoed and anything else is generalised, with the detail
 * going to the container's own log. CodeQL flagged the previous code for
 * information exposure and it was right: it echoed every `error.message` alike.
 */
class BuildError extends Error {}

/** Must match `MAX_ROOT_DIRECTORY_LENGTH` in `src/builds/paths.ts`. */
const MAX_ROOT_DIRECTORY_LENGTH = 256;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Re-validate the root directory the control plane sent. It already validated
 * it, but this box trusts nothing that arrives over HTTP. The rules match
 * `normalizeRootDirectory` in `src/builds/paths.ts`, minus the trimming — what
 * reaches here is already normalized, so anything else is refused, not fixed.
 * @param {string} value The `rootDirectory` query parameter; `""` is the repository root.
 * @returns {string} The same value, once proven clean.
 */
const validateRootDirectory = (value) => {
    if (value === "") {
        return value;
    }

    if (
        value.length > MAX_ROOT_DIRECTORY_LENGTH ||
        CONTROL_CHARACTERS.test(value) ||
        value.includes("\\") ||
        value.startsWith("/") ||
        value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        throw new BuildError(`root directory "${value.slice(0, 80)}" is not a normalized repository-relative path and was refused`);
    }

    return value;
};

/**
 * Is `child` the same as, or inside, `parent`? Both must already be real paths.
 * The trailing separator is what stops `/w/build-a` matching `/w/build-ab`.
 * @param {string} parent A resolved directory.
 * @param {string} child A resolved path.
 * @returns {boolean} Whether `child` is contained.
 */
const isInside = (parent, child) => child === parent || child.startsWith(parent + sep);

/**
 * Resolve the project directory inside the extracted repo.
 *
 * `realpath` on both sides before the prefix check: the tarball is the
 * tenant's, so `apps/web` may be a symlink to `/` or `../../`, and a check on
 * the unresolved string would pass it. After `realpath` there are no links
 * left to follow, so containment of the real path is containment, full stop.
 * @param {string} repo The directory the tarball was extracted into.
 * @param {string} rootDirectory A validated root directory; `""` is the repo itself.
 * @returns {Promise<{ project: string, repo: string }>} Both as real paths.
 */
const resolveProjectDirectory = async (repo, rootDirectory) => {
    const realRepo = await realpath(repo);

    if (validateRootDirectory(rootDirectory) === "") {
        return { project: realRepo, repo: realRepo };
    }

    let project;

    try {
        project = await realpath(resolve(realRepo, rootDirectory));
    } catch {
        throw new BuildError(`root directory "${rootDirectory}" does not exist in the repository at this commit`);
    }

    if (!isInside(realRepo, project)) {
        throw new BuildError(`root directory "${rootDirectory}" resolves outside the repository (through a symlink) and was refused`);
    }

    const info = await stat(project);

    if (!info.isDirectory()) {
        throw new BuildError(`root directory "${rootDirectory}" is not a directory`);
    }

    return { project, repo: realRepo };
};

/**
 * Which package manager a directory's lockfile was written by, or `null`.
 *
 * The lockfile decides, never a default: installing a pnpm project with npm
 * resolves a different dependency graph than the one the tenant tested.
 * @param {string} directory Directory to look in.
 * @returns {Promise<{ args: string[], command: string } | undefined>} The install command, or `undefined` without a lockfile.
 */
const packageManagerIn = async (directory) => {
    const entries = new Set(await readdir(directory));

    if (entries.has("pnpm-lock.yaml")) {
        return { args: ["install", "--frozen-lockfile"], command: "pnpm" };
    }

    if (entries.has("package-lock.json")) {
        return { args: ["ci"], command: "npm" };
    }

    if (entries.has("yarn.lock")) {
        return { args: ["install", "--immutable"], command: "yarn" };
    }

    return undefined;
};

/**
 * The workspace root: the nearest directory from the project upward that holds
 * a lockfile, stopping at the repo. For a pnpm/yarn/npm workspace that is the
 * repo root (one lockfile for every package); for a standalone app committed
 * inside a larger repo it is the app itself.
 * @param {string} project Real path of the project directory.
 * @param {string} repo Real path of the extracted repo.
 * @returns {Promise<{ directory: string, manager: { args: string[], command: string } }>} Where to install, and with what.
 */
const findWorkspaceRoot = async (project, repo) => {
    for (let directory = project; isInside(repo, directory); directory = dirname(directory)) {
        // eslint-disable-next-line no-await-in-loop -- one level at a time, nearest first
        const manager = await packageManagerIn(directory);

        if (manager !== undefined) {
            return { directory, manager };
        }

        if (directory === repo) {
            break;
        }
    }

    throw new BuildError("no lockfile found (pnpm-lock.yaml, package-lock.json or yarn.lock) — a reproducible build needs one");
};

/**
 * The project's own installed `lunora` binary: the nearest
 * `node_modules/.bin/lunora` from the project up to the workspace root. In a
 * pnpm workspace it sits in the app's own `node_modules`; hoisting managers
 * put it at the root.
 *
 * Deliberately NOT `pnpm exec` / `npm exec` / `yarn run`, which resolve a
 * missing binary from the registry — see the build box README.
 * @param {string} project Real path of the project directory.
 * @param {string} workspaceRoot Real path of the workspace root.
 * @returns {Promise<string>} Absolute path to the binary.
 */
const resolveLunoraBin = async (project, workspaceRoot) => {
    for (let directory = project; isInside(workspaceRoot, directory); directory = dirname(directory)) {
        const binary = join(directory, "node_modules", ".bin", "lunora");

        try {
            // eslint-disable-next-line no-await-in-loop -- nearest first
            await access(binary);

            return binary;
        } catch {
            // Keep walking up.
        }

        if (directory === workspaceRoot) {
            break;
        }
    }

    throw new BuildError(
        "node_modules/.bin/lunora is missing after install — add the Lunora CLI to the project's dependencies " +
            "(`lunorash` or `@lunora/cli`). Yarn PnP projects are not supported by the build box.",
    );
};

export { BuildError, findWorkspaceRoot, resolveLunoraBin, resolveProjectDirectory, validateRootDirectory };
