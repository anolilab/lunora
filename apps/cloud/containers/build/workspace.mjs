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
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A path with a `node_modules` segment: an installed copy, never a workspace package. */
const IN_NODE_MODULES = /(?:^|[\\/])node_modules(?:[\\/]|$)/u;

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

/** Must match `MAX_WORKSPACE_PACKAGES` in `lunora/builds.ts`. */
const MAX_WORKSPACE_PACKAGES = 200;

/** Every dependency kind: over-watching costs a redundant build, under-watching a missed deploy. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Where `name` is installed for a package in `directory`: the nearest
 * `node_modules/<name>` from there up to the workspace root, as a real path.
 * @param {string} directory Real path of the depending package.
 * @param {string} name The dependency's package name.
 * @param {string} workspaceRoot Real path of the workspace root.
 * @returns {Promise<string | undefined>} The installed package's real path, or `undefined`.
 */
const installedPath = async (directory, name, workspaceRoot) => {
    for (let current = directory; isInside(workspaceRoot, current); current = dirname(current)) {
        try {
            // eslint-disable-next-line no-await-in-loop -- nearest first
            return await realpath(join(current, "node_modules", name));
        } catch {
            // Keep walking up.
        }

        if (current === workspaceRoot) {
            break;
        }
    }

    return undefined;
};

/**
 * The repo-relative directories of the workspace packages the project depends
 * on from outside its own directory, transitively — what a push must touch,
 * besides the project and the lockfile, to change the build.
 *
 * Read off the installed tree rather than the workspace manifest: after the
 * install, a workspace dependency is a `node_modules` link to its source
 * directory under every node-modules linker (pnpm, npm, Yarn's), so the
 * package manager has already resolved `workspace:`, `file:` and `link:`
 * specifiers, globs and hoisting, and a registry package is the target that
 * lands inside a `node_modules`. A link resolving outside the repo is ignored,
 * so the answer never names anything but the tenant's own tree.
 * @param {string} project Real path of the project directory.
 * @param {string} workspaceRoot Real path of the workspace root.
 * @param {string} repo Real path of the extracted repo.
 * @returns {Promise<string[] | undefined>} Sorted directories (`""` is the repo root), or `undefined` past the cap.
 */
const workspacePackages = async (project, workspaceRoot, repo) => {
    const seen = new Set([project]);
    const queue = [project];
    const found = [];

    while (queue.length > 0) {
        const directory = queue.shift();
        let manifest;

        try {
            // eslint-disable-next-line no-await-in-loop -- breadth-first over a small graph
            manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        } catch {
            continue;
        }

        const names = DEPENDENCY_FIELDS.flatMap((field) =>
            typeof manifest?.[field] === "object" && manifest[field] !== null ? Object.keys(manifest[field]) : [],
        );

        for (const name of names) {
            // eslint-disable-next-line no-await-in-loop -- see above
            const target = await installedPath(directory, name, workspaceRoot);

            if (target === undefined || seen.has(target) || !isInside(repo, target) || IN_NODE_MODULES.test(relative(repo, target))) {
                continue;
            }

            seen.add(target);
            queue.push(target);

            if (!isInside(project, target)) {
                found.push(relative(repo, target).split(sep).join("/"));
            }

            if (found.length > MAX_WORKSPACE_PACKAGES) {
                return undefined;
            }
        }
    }

    return found.toSorted();
};

export { BuildError, findWorkspaceRoot, resolveLunoraBin, resolveProjectDirectory, validateRootDirectory, workspacePackages };
