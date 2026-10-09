/**
 * The `runtime: "worker"` build: a plain Cloudflare Worker project — a wrangler
 * config and the project's own pinned `wrangler`, no Lunora CLI — turned into
 * the same release a Lunora project's `lunora cloud deploy --out` writes, so it
 * goes through the same bundle scan, caps and deploy core.
 *
 * Three steps, each kept where the trust boundary says it belongs.
 *
 * First, the config is read with the tenant's own wrangler
 * ({@link READ_CONFIG_PROGRAM}). Its resolved config — TOML or JSON, defaults
 * applied, `main` absolute — is the one its `wrangler deploy` would use. That is
 * tenant code, so it runs in a child process that only writes the config, as
 * JSON, to a file outside the tree.
 *
 * Second, it is translated here ({@link releaseFromConfig}), with the vendored
 * `buildBindingManifest` and `collectAssets` (`vendor/release-manifest.mjs`,
 * bundled from `@lunora/config` / `@lunora/cli` source) imported at start-up —
 * `/srv` is writable by the user builds run as, so nothing is loaded from it
 * once a build has run.
 *
 * Third, `wrangler deploy --dry-run` bundles the Worker, entering through a
 * generated shim ({@link shimSource}) instead of its `main`: the shim re-exports
 * everything the Worker exports and answers the platform's `/_lunora/scheduled`
 * and `/_lunora/queue` routes from its own `scheduled()` and `queue()` (see
 * `shim-runtime.mjs` for why). The shim is written to the project's
 * `.wrangler/lunora-cloud/` ({@link writeShim}, for a bundle that is the same
 * on every build of a commit); the resolved config, the out-dir and wrangler's
 * logs live beside the extracted repo, never in it.
 *
 * The shim is applied whatever the project's target: the box does not know it,
 * and a build is reused across a target change. On a target that runs crons and
 * queue consumers natively (`cloudflare-workers`, `celld-vps`), the platform
 * never calls the two routes and the Worker's handlers are invoked directly
 * through the wrapper, unchanged.
 */
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { buildBindingManifest, collectAssets } from "./vendor/release-manifest.mjs";
import { BuildError, findWranglerConfig, isInside, resolveWranglerBin } from "./workspace.mjs";

/**
 * The shim's runtime, read now — at start-up, before any build — for the reason
 * the vendored module is imported now. Written beside each build's shim.
 */
const SHIM_RUNTIME_SOURCE = readFileSync(new URL("shim-runtime.mjs", import.meta.url), "utf8");

/** The two values the `runtime` query parameter takes. Absent is `lunora`. */
const RUNTIMES = new Set(["lunora", "worker"]);

/** Largest resolved config the box reads back: a wrangler config is a few KiB. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Most entries {@link assertContainedTree} walks before refusing: the assets cap is 20,000 files. */
const MAX_ASSET_ENTRIES = 25_000;

/** Every `CLOUDFLARE_*` variable steers wrangler at an account; a dry run needs none of them. */
const CLOUDFLARE_VARIABLE = /^CLOUDFLARE_/u;

/**
 * Re-validate the `runtime` query parameter. The control plane already
 * validated it; this box trusts nothing that arrives over HTTP.
 * @param {string | null} value The parameter, `null` when absent.
 * @returns {"lunora" | "worker"} The runtime.
 */
const validateRuntime = (value) => {
    if (value === null || value === "") {
        return "lunora";
    }

    if (!RUNTIMES.has(value)) {
        throw new BuildError(`runtime "${value.slice(0, 40)}" is not one of lunora, worker and was refused`);
    }

    return /** @type {"lunora" | "worker"} */ (value);
};

/**
 * The child program that reads the config with the project's own wrangler and
 * writes it to a file. Run with `node --input-type=module --eval`, so it is
 * never a file a build could have replaced.
 *
 * Only the keys the config file itself declares are kept (read off the raw
 * config): the resolved one carries every default wrangler knows, and the
 * manifest would report each as a section it does not model. The values are the
 * resolved ones — `main` absolute, inheritable keys applied. The top-level
 * environment only: a git build has no `--env`.
 */
const READ_CONFIG_PROGRAM = String.raw`
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

const [project, configPath, workspaceRoot, out] = process.argv.slice(1);
const fail = (message) => {
    process.stderr.write(message + "\n");
    process.exit(3);
};
const require = createRequire(join(project, "package.json"));
let entry;

try {
    entry = realpathSync(require.resolve("wrangler"));
} catch {
    fail("the project's wrangler package cannot be resolved from " + project);
}

if (!entry.startsWith(workspaceRoot + sep)) {
    fail("the project's wrangler package resolves outside the repository");
}

const wrangler = require(entry);

if (typeof wrangler.unstable_readConfig !== "function" || typeof wrangler.experimental_readRawConfig !== "function") {
    fail("this wrangler version cannot report its resolved config (no unstable_readConfig / experimental_readRawConfig); upgrade wrangler to a current 4.x");
}

const config = wrangler.unstable_readConfig({ config: configPath }, { hideWarnings: true });
const { rawConfig } = wrangler.experimental_readRawConfig({ config: configPath });
const picked = {};

for (const key of Object.keys(rawConfig)) {
    if (key !== "env" && config[key] !== undefined) {
        picked[key] = config[key];
    }
}

writeFileSync(out, JSON.stringify({ config: picked }));
`;

/**
 * @param {unknown} value Anything.
 * @returns {value is Record<string, unknown>} Whether it is a plain JSON object.
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where a symlink in the assets tree leads, refused when that is outside the
 * repository or nowhere at all.
 * @param {string} path The link.
 * @param {string} repo Real path of the extracted repo.
 * @returns {Promise<string>} Its real target.
 */
const containedTarget = async (path, repo) => {
    let target;

    try {
        target = await realpath(path);
    } catch {
        throw new BuildError(`the asset ${relative(repo, path)} is a broken symlink`);
    }

    if (!isInside(repo, target)) {
        throw new BuildError(`the asset ${relative(repo, path)} is a symlink that leads outside the repository and was refused`);
    }

    return target;
};

/**
 * Refuse a tree that reaches outside the repository through a symlink.
 * `collectAssets` follows links, so `public/x -> /` would otherwise publish the
 * build container's own files as the Worker's public assets. A linked directory
 * elsewhere in the repo is walked too, since its links are followed as well.
 * @param {string} directory Real path of the directory to walk.
 * @param {string} repo Real path of the extracted repo.
 * @returns {Promise<void>}
 */
const assertContainedTree = async (directory, repo) => {
    const queue = [directory];
    const walked = new Set(queue);
    let seen = 0;

    while (queue.length > 0) {
        // eslint-disable-next-line no-await-in-loop -- breadth-first, one directory at a time
        const entries = await readdir(/** @type {string} */ (queue.shift()), { recursive: false, withFileTypes: true });

        seen += entries.length;

        if (seen > MAX_ASSET_ENTRIES) {
            throw new BuildError(`the assets directory holds more than ${String(MAX_ASSET_ENTRIES)} entries; Lunora Cloud deploys at most 20000 files`);
        }

        for (const entry of entries) {
            const path = join(entry.parentPath, entry.name);
            // eslint-disable-next-line no-await-in-loop -- see above
            const next = entry.isSymbolicLink() ? await containedTarget(path, repo) : path;
            // eslint-disable-next-line no-await-in-loop -- see above
            const info = entry.isSymbolicLink() ? await lstat(next) : entry;

            if (info.isDirectory() && !walked.has(next)) {
                walked.add(next);
                queue.push(next);
            }
        }
    }
};

/**
 * The static assets, collected as `lunora cloud deploy` collects them — but
 * with the directory and every link under it proven to stay in the repository.
 * @param {Record<string, unknown>} assets The config's `assets` section.
 * @param {string} configPath Absolute path of the wrangler config.
 * @param {string} repo Real path of the extracted repo.
 * @returns {Promise<unknown>} The `assets` upload.
 */
const collectContainedAssets = async (assets, configPath, repo) => {
    if (typeof assets.directory !== "string" || assets.directory === "") {
        throw new BuildError("the wrangler `assets` section has no `directory` — set it to the directory of files to serve");
    }

    let directory;

    try {
        directory = await realpath(resolve(dirname(configPath), assets.directory));
    } catch {
        throw new BuildError(
            `the assets directory "${assets.directory}" does not exist after the build — point assets.directory at your build output, or produce it in wrangler's \`build.command\``,
        );
    }

    if (!isInside(repo, directory)) {
        throw new BuildError(`the assets directory "${assets.directory}" resolves outside the repository and was refused`);
    }

    await assertContainedTree(directory, repo);

    try {
        return collectAssets(directory, assets);
    } catch (error) {
        throw new BuildError(error instanceof Error ? error.message : String(error));
    }
};

/**
 * `vars`, as plain-text bindings. Lunora Cloud deploys a var as a string; a
 * wrangler var may be a number, boolean or object, which Cloudflare would bind
 * as JSON. Converting one would change what the Worker reads (`3` → `"3"`)
 * without a word, so a non-string var is refused, by name.
 * @param {unknown} variables The config's `vars`.
 * @returns {Record<string, string>} The vars.
 */
const plainTextVariables = (variables) => {
    if (variables === undefined) {
        return {};
    }

    if (!isRecord(variables)) {
        throw new BuildError("the wrangler `vars` section must be an object of name → value");
    }

    const refused = Object.entries(variables)
        .filter(([, value]) => typeof value !== "string")
        .map(([name, value]) => `${name} (${Array.isArray(value) ? "array" : typeof value})`);

    if (refused.length > 0) {
        throw new BuildError(
            `Lunora Cloud deploys wrangler vars as plain text, and these are not strings: ${refused.join(", ")}. Quote them in the wrangler config (and parse them in the Worker), or move them to a secret.`,
        );
    }

    return /** @type {Record<string, string>} */ ({ ...variables });
};

/**
 * The `ASSETS` binding to add for a config's `assets` section, when it names
 * none. The provision box binds uploaded assets as ASSETS, always: a Worker
 * that names no binding reads none, so ASSETS is added for it; one that reads
 * another name would find it undefined at runtime, so that is refused.
 * @param {Record<string, unknown>} section The config's `assets` section.
 * @returns {{ binding: string, type: "assets" } | undefined} The binding to add.
 */
const assetsBinding = (section) => {
    if (section.binding !== undefined && section.binding !== "ASSETS") {
        throw new BuildError(
            `the assets binding is named ${String(section.binding)}, but Lunora Cloud binds static assets as ASSETS — rename it in the wrangler config and in the Worker`,
        );
    }

    return section.binding === undefined ? { binding: "ASSETS", type: "assets" } : undefined;
};

/**
 * Producer binding → the Worker's own queue name, for every queue the Worker
 * also consumes: what the shim maps a forwarded `{alias}--{binding}` queue
 * name back through. Keyed by `--` plus the binding as `releaseResourceName`
 * spells it (`@lunora/config/celld`): lowercase, `_` → `-`.
 * @param {ReadonlyArray<{ binding: string, resource?: string, type: string }>} bindings The manifest's bindings.
 * @returns {Record<string, string>} The map.
 */
const forwardedQueueNames = (bindings) => {
    const consumed = new Set(bindings.filter((entry) => entry.type === "queue_consumer").map((entry) => entry.resource));

    return Object.fromEntries(
        bindings
            .filter((entry) => entry.type === "queue_producer" && entry.resource !== undefined && consumed.has(entry.resource))
            .map((entry) => [`--${entry.binding.toLowerCase().replaceAll("_", "-")}`, /** @type {string} */ (entry.resource)]),
    );
};

/**
 * Translate a resolved wrangler config into the release a deploy needs —
 * exactly the body `lunora cloud deploy --out` writes, plus `vars` — and the
 * queue-name map the shim embeds. Refuses, by name, anything that would deploy
 * a Worker missing part of what its config says. Everything but the static
 * files themselves: those may be what wrangler's `build.command` produces, so
 * they are collected after the dry run ({@link collectContainedAssets}), from
 * the `assets` section returned here.
 * @param {{ config: Record<string, unknown>, configPath: string, log: (line: string) => void }} input The config, where it was read from, and a log line writer.
 * @returns {{ assets?: Record<string, unknown>, body: Record<string, unknown>, main: string, queueNames: Record<string, string> }} The release body without its files, the `assets` section to collect them from, the Worker's entry and the map.
 */
const releaseFromConfig = ({ config, configPath, log }) => {
    if (typeof config.main !== "string" || config.main === "") {
        throw new BuildError(`${basename(configPath)} has no \`main\` — a Worker needs an entry module`);
    }

    if (config.no_bundle === true) {
        throw new BuildError("`no_bundle` is not supported: Lunora Cloud deploys one bundled module, which `wrangler deploy` produces only when it bundles");
    }

    const variables = plainTextVariables(config.vars);
    const manifest = buildBindingManifest(config);

    if (manifest.unknown.length > 0) {
        log(
            `warning: the binding manifest does not model these wrangler sections: ${manifest.unknown.join(", ")}. Anything they bind will be missing from the deployment.`,
        );
    }

    const assets = isRecord(config.assets) ? config.assets : undefined;
    const binding = assets === undefined ? undefined : assetsBinding(assets);
    const bindings = binding === undefined ? [...manifest.bindings] : [...manifest.bindings, binding];

    // In the manifest's own order (type, then binding), so the release stays diff-stable.
    bindings.sort((a, b) => a.type.localeCompare(b.type) || a.binding.localeCompare(b.binding));

    return {
        ...(assets === undefined ? {} : { assets }),
        body: {
            ...(manifest.crons.length > 0 ? { cronSpecs: [...manifest.crons] } : {}),
            manifest: {
                bindings,
                ...(manifest.compatibilityDate === undefined ? {} : { compatibilityDate: manifest.compatibilityDate }),
                ...(manifest.compatibilityFlags === undefined ? {} : { compatibilityFlags: [...manifest.compatibilityFlags] }),
                ...(Object.keys(variables).length > 0 ? { vars: variables } : {}),
            },
            ...(typeof config.name === "string" && config.name !== "" ? { scriptName: config.name } : {}),
        },
        main: config.main,
        queueNames: forwardedQueueNames(bindings),
    };
};

/**
 * The generated entry: the Worker's module, re-exported whole (Durable Object,
 * Workflow and named-entrypoint classes stay exports of the bundle), with its
 * default handler wrapped by `shim-runtime.mjs`'s `wrapEntry`.
 * @param {{ main: string, queueNames: Record<string, string> }} input The Worker's absolute entry and the queue-name map.
 * @returns {string} The module source.
 */
const shimSource = ({ main, queueNames }) => {
    // JSON-quoted: `main` is the tenant's, and a quote in it must stay a quote.
    const entry = JSON.stringify(main);

    return [
        "// Generated by the Lunora Cloud build box for this Worker's deploy; see containers/build/shim-runtime.mjs.",
        `import * as worker from ${entry};`,
        'import { wrapEntry } from "./shim-runtime.mjs";',
        "",
        `export * from ${entry};`,
        `export default wrapEntry(worker.default, ${JSON.stringify(queueNames)});`,
        "",
    ].join("\n");
};

/** Where the generated entry is written, relative to the project: wrangler's own scratch directory. */
const SHIM_DIRECTORY = [".wrangler", "lunora-cloud"];

/**
 * Write the generated entry and the shim runtime into
 * `<project>/.wrangler/lunora-cloud/`, and answer the entry's path.
 *
 * In the tree, at a fixed path, rather than beside the repo with the rest of
 * the scratch files: the bundle's region comments name every input relative to
 * the project, so an entry under the build's random workspace name would change
 * the bundle — and its hash — on every build of the same commit. `.wrangler`
 * is wrangler's own output directory, and one the bundle scan already treats as
 * generated, so nothing in the shim is ever reported as the tenant's code.
 * Created fresh, and refused when any part of it resolves elsewhere: the tree
 * is the tenant's, so the path may arrive as a symlink.
 * @param {string} project Real path of the project directory.
 * @param {string} source The entry's source ({@link shimSource}).
 * @returns {Promise<string>} The entry's absolute path.
 */
const writeShim = async (project, source) => {
    const directory = join(project, ...SHIM_DIRECTORY);
    const parent = await lstat(join(project, SHIM_DIRECTORY[0])).catch(() => undefined);

    // Checked before anything is removed: through a linked `.wrangler`, the removal would land wherever it points.
    if (parent?.isSymbolicLink() === true) {
        throw new BuildError(`${SHIM_DIRECTORY[0]} is a symlink in the repository; remove it, it is wrangler's own output directory`);
    }

    await rm(directory, { force: true, recursive: true });
    await mkdir(directory, { recursive: true });

    if ((await realpath(directory)) !== directory) {
        throw new BuildError(`${SHIM_DIRECTORY.join("/")} resolves outside the project through a symlink and was refused`);
    }

    // `wx`: a file that appeared since — a link planted in between — fails the write instead of being followed.
    await writeFile(join(directory, "shim-runtime.mjs"), SHIM_RUNTIME_SOURCE, { flag: "wx" });
    await writeFile(join(directory, "index.mjs"), source, { flag: "wx" });

    return join(directory, "index.mjs");
};

/**
 * Whether the project builds with `@cloudflare/vite-plugin`: its deployable
 * config is produced by `vite build`, which `wrangler deploy` does not run, so
 * it would ship without its frontend. Refused rather than half-deployed.
 * @param {string} project Real path of the project directory.
 * @returns {Promise<boolean>} Whether the plugin is a dependency.
 */
const usesVitePlugin = async (project) => {
    let manifest;

    try {
        manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    } catch {
        return false;
    }

    return ["dependencies", "devDependencies"].some((field) => isRecord(manifest?.[field]) && "@cloudflare/vite-plugin" in manifest[field]);
};

/**
 * The environment wrangler runs with: no telemetry, no update check (the
 * banner is what runs it), its log file beside the repo, and no
 * `CLOUDFLARE_*` variable that could point it at an account.
 * @param {string} logDirectory Where wrangler writes its debug log.
 * @returns {Record<string, string>} The environment.
 */
const wranglerEnvironment = (logDirectory) => {
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !CLOUDFLARE_VARIABLE.test(name))),
        WRANGLER_HIDE_BANNER: "true",
        WRANGLER_LOG_PATH: logDirectory,
        WRANGLER_SEND_METRICS: "false",
    };
};

/**
 * Read the config, translate it, write the shim and bundle the Worker.
 * @param {{ onLine: (line: string) => void, project: string, repo: string, run: (command: string, args: string[], options: Record<string, unknown>, onLine: (line: string) => void) => Promise<number>, scratch: string, timeoutMs: number, workspaceRoot: string }} input The build's directories (real paths), the process runner, a scratch directory OUTSIDE the repo, and the wall-clock cap.
 * @returns {Promise<{ body: Record<string, unknown>, outDirectory: string }>} The release body (minus the bundle) and where the bundle was written.
 */
const buildWorker = async ({ onLine, project, repo, run, scratch, timeoutMs, workspaceRoot }) => {
    const configPath = await findWranglerConfig(project);

    if (configPath === undefined) {
        throw new BuildError(
            `no wrangler.json, wrangler.jsonc or wrangler.toml in ${project === repo ? "the repository root" : relative(repo, project)} — a Cloudflare Worker project deploys from its wrangler config`,
        );
    }

    if (await usesVitePlugin(project)) {
        throw new BuildError(
            "this Worker builds with @cloudflare/vite-plugin, whose deployable output comes from `vite build`, which a Cloudflare Worker build does not run — deploy it as a Lunora app or with `wrangler deploy` for now",
        );
    }

    const wrangler = await resolveWranglerBin(project, workspaceRoot);

    await mkdir(scratch, { recursive: true });

    const configFile = join(scratch, "config.json");

    onLine(`reading ${basename(configPath)} with the project's wrangler`);

    const readCode = await run(
        process.execPath,
        ["--input-type=module", "--eval", READ_CONFIG_PROGRAM, "--", project, configPath, workspaceRoot, configFile],
        { cwd: project, label: "reading the wrangler config", timeoutMs },
        onLine,
    );

    if (readCode !== 0) {
        throw new BuildError(`the project's wrangler could not read ${basename(configPath)} (exit code ${String(readCode)}); its output is above`);
    }

    const raw = await readFile(configFile);

    if (raw.length > MAX_CONFIG_BYTES) {
        throw new BuildError(`the resolved wrangler config is over ${String(MAX_CONFIG_BYTES / 1024 / 1024)} MiB`);
    }

    let parsed;

    try {
        parsed = JSON.parse(raw.toString("utf8"));
    } catch {
        parsed = undefined;
    }

    if (!isRecord(parsed) || !isRecord(parsed.config)) {
        throw new BuildError("the project's wrangler reported a config that is not an object");
    }

    const { assets, body, main, queueNames } = releaseFromConfig({ config: parsed.config, configPath, log: onLine });

    const shim = await writeShim(project, shimSource({ main, queueNames }));

    const outDirectory = join(scratch, "out");

    onLine(`running wrangler deploy --dry-run in ${project === repo ? "the repository root" : relative(repo, project)}`);

    const buildCode = await run(
        wrangler,
        ["deploy", shim, "--config", configPath, "--dry-run", "--outdir", outDirectory],
        { cwd: project, env: wranglerEnvironment(join(scratch, "logs")), label: "`wrangler deploy --dry-run`", timeoutMs },
        onLine,
    );

    if (buildCode !== 0) {
        throw new BuildError(`wrangler deploy --dry-run failed with exit code ${String(buildCode)}`);
    }

    // After the dry run, which ran the config's `build.command`: the files may be its output.
    return { body: assets === undefined ? body : { assets: await collectContainedAssets(assets, configPath, repo), ...body }, outDirectory };
};

/**
 * Where a worker build keeps its scratch files: beside the extracted repo, never inside it.
 * @param {string} workspace The directory the tarball was extracted into.
 * @returns {string} The scratch directory.
 */
const workerScratch = (workspace) => `${workspace}.worker`;

export { buildWorker, forwardedQueueNames, plainTextVariables, READ_CONFIG_PROGRAM, releaseFromConfig, shimSource, validateRuntime, workerScratch };
