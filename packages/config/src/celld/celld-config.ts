/**
 * The wrangler config as celld accepts it.
 *
 * `celld deploy` / `celld dev` read the project's Wrangler config, but refuse
 * any top-level key outside a fixed list — and Lunora writes several
 * (`observability` from the binding reconciler, `limits` / `version_metadata`
 * from the templates). Rather than keep those keys out of the project's own
 * `wrangler.jsonc`, which Cloudflare still needs, the celld driver deploys a
 * projection of it.
 *
 * Two sources. A project whose `main` is a worker file is projected from its
 * own config. A project on `@lunora/vite` whose `main` is the virtual worker
 * entry has no file for celld's esbuild to start from, so it deploys the Vite
 * build output instead — the config `@cloudflare/vite-plugin` writes beside
 * the bundle and records in `.wrangler/deploy/config.json`.
 *
 * The projection is written where celld will accept it: celld takes the
 * config's directory as the project root and requires every path the config
 * names to sit inside it, so the file goes in the deepest directory holding
 * both the config's own directory and those paths — the project root for a
 * source entry, the build's output root for a Vite build (whose assets sit in a
 * sibling of the server bundle).
 *
 * The accepted keys track celld v0.5.1's `docs/cloudflare-compat.md`
 * ("Wrangler configuration") and `docs/services/containers.md`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { findWranglerFile, readWranglerJsonc } from "../cloudflare/wrangler-path";
import type { ProjectedConfig, ProjectionPurpose } from "../deploy-driver";

/** The projected config's filename. */
const CELLD_CONFIG_FILE = ".celld.wrangler.json";

/** Where `@cloudflare/vite-plugin` records the config of the last `vite build`. */
const VITE_DEPLOY_REDIRECT = join(".wrangler", "deploy", "config.json");

/** Top-level keys `celld deploy` accepts; any other stops the deploy. */
const ACCEPTED_KEYS = new Set([
    "$schema",
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "containers",
    "d1_databases",
    "define",
    "durable_objects",
    "kv_namespaces",
    "main",
    "migrations",
    "name",
    "no_bundle",
    "queues",
    "r2_buckets",
    "rules",
    "services",
    "triggers",
    "vars",
    "worker_loaders",
    "workflows",
]);

/** Keys a `containers` entry may carry on celld. */
const CONTAINER_KEYS = new Set(["class_name", "image", "instance_type", "max_instances", "name", "runtime"]);

/** Module rule types celld's bundler supports. */
const RULE_TYPES = new Set(["CompiledWasm", "Data", "Text"]);

const LINE_BREAK = /\r?\n/u;

/** Glob or negation syntax in an ignore pattern — anything that is not a literal path. */
const IGNORE_PATTERN_SYNTAX = /[!*?[]/u;

/** Where a dropped entry's top-level key ends (`containers[0].x`, `rules[1]`). */
const KEY_END = /[.[]/u;

/** Migration steps celld refuses: it only ever creates SQLite-backed classes. */
const REFUSED_MIGRATION_STEPS = ["deleted_classes", "new_classes", "renamed_classes", "transferred_classes"];

type Config = Record<string, unknown>;

const isRecord = (value: unknown): value is Config => typeof value === "object" && value !== null && !Array.isArray(value);

/** Configures nothing: `[]`, `{}`, or an object of such (`{ bindings: [] }`). */
const isEmpty = (value: unknown): boolean =>
    (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.values(value).every((entry) => isEmpty(entry)));

/**
 * A migration keeps only `tag` + `new_sqlite_classes`. A step that renames,
 * deletes, transfers or creates a KV-backed class is refused here, by name —
 * celld would refuse the whole deploy anyway, and dropping the step instead
 * would deploy a class layout the migration history says does not exist.
 */
const projectMigrations = (migrations: unknown): unknown => {
    if (!Array.isArray(migrations)) {
        return migrations;
    }

    return migrations.map((migration: unknown) => {
        if (!isRecord(migration)) {
            return migration;
        }

        const refused = REFUSED_MIGRATION_STEPS.find((step) => migration[step] !== undefined);

        if (refused !== undefined) {
            throw new Error(
                `migration "${String(migration["tag"])}" uses \`${refused}\`, which celld refuses — celld accepts only \`new_sqlite_classes\` migrations`,
            );
        }

        return { new_sqlite_classes: migration["new_sqlite_classes"], tag: migration["tag"] };
    });
};

const projectContainers = (containers: unknown, dropped: string[]): unknown => {
    if (!Array.isArray(containers)) {
        return containers;
    }

    return containers.map((container: unknown, index) => {
        if (!isRecord(container)) {
            return container;
        }

        return Object.fromEntries(
            Object.entries(container).filter(([key]) => {
                const kept = CONTAINER_KEYS.has(key);

                if (!kept) {
                    dropped.push(`containers[${String(index)}].${key}`);
                }

                return kept;
            }),
        );
    });
};

/** Keep the module rules celld's bundler knows; any other type stops the deploy. */
const projectRules = (rules: unknown, dropped: string[]): unknown => {
    if (!Array.isArray(rules)) {
        return rules;
    }

    return rules.filter((rule: unknown, index) => {
        const kept = isRecord(rule) && typeof rule["type"] === "string" && RULE_TYPES.has(rule["type"]);

        if (!kept) {
            dropped.push(`rules[${String(index)}]`);
        }

        return kept;
    });
};

/**
 * Project a parsed wrangler config onto what celld accepts.
 * @param config The parsed wrangler config.
 * @returns the projected config and every key removed from it. A removed key
 * whose value configures nothing (`[]`, `{}`) is not reported.
 * @throws when a migration uses a step celld refuses.
 */
const projectCelldConfig = (config: Config): { config: Config; dropped: string[] } => {
    const dropped: string[] = [];
    const projected: Config = {};

    for (const [key, value] of Object.entries(config)) {
        if (!ACCEPTED_KEYS.has(key)) {
            if (!isEmpty(value)) {
                dropped.push(key);
            }

            continue;
        }

        switch (key) {
            case "containers": {
                projected[key] = projectContainers(value, dropped);

                break;
            }
            case "migrations": {
                projected[key] = projectMigrations(value);

                break;
            }
            case "rules": {
                projected[key] = projectRules(value, dropped);

                break;
            }
            default: {
                projected[key] = value;
            }
        }
    }

    return { config: projected, dropped };
};

/** The deepest directory containing every one of `paths` (absolute). */
const commonDirectory = (paths: ReadonlyArray<string>): string => {
    const [first = [], ...rest] = paths.map((path) => resolve(path).split(sep));
    let depth = 0;

    while (depth < first.length && rest.every((segments) => segments[depth] === first[depth])) {
        depth += 1;
    }

    return first.slice(0, depth).join(sep) || sep;
};

/**
 * Rewrite `main` and `assets.directory` — relative to the source config's
 * directory — relative to `root`, where the projection is written.
 */
const rebasePaths = (config: Config, sourceDirectory: string, root: string): Config => {
    const rebase = (path: string): string => relative(root, resolve(sourceDirectory, path)).split(sep).join("/");
    const rebased: Config = { ...config };

    if (typeof config["main"] === "string") {
        rebased["main"] = rebase(config["main"]);
    }

    if (isRecord(config["assets"]) && typeof config["assets"]["directory"] === "string") {
        rebased["assets"] = { ...config["assets"], directory: rebase(config["assets"]["directory"]) };
    }

    return rebased;
};

/**
 * `@cloudflare/vite-plugin` writes an `.assetsignore` into the client output
 * so `wrangler deploy` does not serve its own `wrangler.json` / `.dev.vars` as
 * assets. celld refuses the file outright. When none of its patterns names
 * anything present it guards nothing, so the build artifact can go; otherwise
 * the deploy stops rather than publish what it was hiding.
 * @returns the file to remove, or `undefined` when there is none.
 * @throws when a pattern still hides something.
 */
const inertAssetsIgnore = (assetsDirectory: string): string | undefined => {
    const file = join(assetsDirectory, ".assetsignore");

    if (!existsSync(file)) {
        return undefined;
    }

    const live = readFileSync(file, "utf8")
        .split(LINE_BREAK)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .filter((pattern) => IGNORE_PATTERN_SYNTAX.test(pattern) || existsSync(join(assetsDirectory, pattern)));

    if (live.length > 0) {
        throw new Error(`${file} hides ${live.join(", ")} from the assets, and celld has no .assetsignore — remove those files from ${assetsDirectory} first`);
    }

    return file;
};

/** The Vite build's wrangler config, via the redirect `@cloudflare/vite-plugin` leaves. */
const readViteBuildConfig = (projectRoot: string, main: string): string => {
    const redirectPath = join(projectRoot, VITE_DEPLOY_REDIRECT);

    if (!existsSync(redirectPath)) {
        throw new Error(
            `wrangler \`main\` is the Vite virtual module "${main}", so celld deploys the Vite build output — and there is none yet. Run the project's build (\`vite build\`) first`,
        );
    }

    const { configPath } = JSON.parse(readFileSync(redirectPath, "utf8")) as { configPath?: unknown };

    if (typeof configPath !== "string") {
        throw new TypeError(`${redirectPath} names no configPath`);
    }

    return resolve(dirname(redirectPath), configPath);
};

const readConfig = (path: string): Config => {
    const { parsed } = readWranglerJsonc<Config>(path);

    if (parsed === undefined) {
        throw new Error(`${path} is not valid JSONC`);
    }

    return parsed;
};

/**
 * Rebase each D1 database's `migrations_dir` onto `root`. celld resolves it
 * against the projection's directory and defaults it to `migrations` there,
 * while wrangler resolves it against the project's own config — so a
 * projection written anywhere but the project root (a Vite build's output)
 * would look for the migrations in the wrong place.
 */
const rebaseMigrationDirectories = (config: Config, own: Config, projectRoot: string, root: string): Config => {
    const { d1_databases: databases } = config;

    if (!Array.isArray(databases) || root === projectRoot) {
        return config;
    }

    const ownDatabases = Array.isArray(own["d1_databases"]) ? (own["d1_databases"] as unknown[]).filter((entry) => isRecord(entry)) : [];

    return {
        ...config,
        d1_databases: databases.map((database: unknown) => {
            if (!isRecord(database)) {
                return database;
            }

            const declared = ownDatabases.find((entry) => entry["binding"] === database["binding"])?.["migrations_dir"];
            const directory = resolve(projectRoot, typeof declared === "string" ? declared : "migrations");

            return existsSync(directory) ? { ...database, migrations_dir: relative(root, directory).split(sep).join("/") } : database;
        }),
    };
};

/**
 * The config the projection is built from: the project's own, or — for a Vite
 * virtual entry — the Vite build's.
 * @throws for a Vite virtual entry in `dev`, or one with no build output yet.
 */
const resolveSource = (
    projectRoot: string,
    wranglerPath: string,
    own: Config,
    purpose: ProjectionPurpose,
): { fromBuild: boolean; source: Config; sourcePath: string } => {
    const { main } = own;

    if (typeof main !== "string" || !main.startsWith("virtual:")) {
        return { fromBuild: false, source: own, sourcePath: wranglerPath };
    }

    if (purpose === "dev") {
        throw new Error(
            `wrangler \`main\` is the Vite virtual module "${main}", which only a Vite build can resolve — \`celld dev\` rebuilds from a source file. Use \`vite dev\` for the dev loop and \`lunora deploy\` to ship the build to celld, or point \`main\` at a worker file`,
        );
    }

    const sourcePath = readViteBuildConfig(projectRoot, main);

    return { fromBuild: true, source: readConfig(sourcePath), sourcePath };
};

/**
 * The build-output adjustments: report only what the project itself
 * configured (the build config carries every key wrangler knows, mostly
 * generated defaults), let celld re-bundle the chunks, and plan removing an
 * inert `.assetsignore`.
 */
const adjustBuildOutput = (
    projected: Config,
    dropped: ReadonlyArray<string>,
    own: Config,
    assetsDirectory: string | undefined,
    root: string,
): { assetsIgnore: string | undefined; projected: Config; reported: string[] } => {
    const reported = dropped.filter((entry) => Object.hasOwn(own, entry.split(KEY_END)[0] ?? entry));
    let bundled = projected;

    // celld's `no_bundle` loads the entry module alone, and the build splits
    // into chunks; its bundler takes the ESM output as-is instead.
    if (projected["no_bundle"] !== undefined) {
        bundled = Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "no_bundle"));
        reported.push("no_bundle (celld re-bundles the build output)");
    }

    const assetsIgnore = assetsDirectory === undefined ? undefined : inertAssetsIgnore(assetsDirectory);

    if (assetsIgnore !== undefined) {
        reported.push(`${relative(root, assetsIgnore)} (matched no files)`);
    }

    return { assetsIgnore, projected: bundled, reported };
};

/**
 * What `wrangler dev --var WORKER_ENV:development` marks on Cloudflare:
 * without it the runtime treats the dev worker as production (live mail, no
 * queue capture). `vars` from the config win, and `.dev.vars` beats both.
 */
const markDevelopment = (projected: Config): Config => {
    const variables = isRecord(projected["vars"]) ? projected["vars"] : {};

    return { ...projected, vars: { WORKER_ENV: "development", ...variables } };
};

/**
 * Plan the celld projection of the project's wrangler config: read, validate
 * and project it without touching the disk. The caller validates the request
 * it is for, then calls `write`.
 * @param projectRoot The directory holding `wrangler.jsonc` / `wrangler.json`.
 * @param purpose `deploy`, or `dev` — `celld dev` rebuilds from source, which a
 * Vite virtual entry does not have, and runs the worker as development.
 * @returns where the projection goes, what it leaves out, and the write.
 * @throws when there is no readable wrangler config, a migration celld refuses,
 * a path outside the project, or a Vite-built worker with no build output (or,
 * for `dev`, at all).
 */
const planCelldConfig = (projectRoot: string, purpose: ProjectionPurpose): ProjectedConfig => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        throw new Error(`no wrangler.jsonc or wrangler.json in ${projectRoot} — celld deploys from the project's Wrangler config`);
    }

    const own = readConfig(wranglerPath);
    const { fromBuild, source, sourcePath } = resolveSource(projectRoot, wranglerPath, own, purpose);
    const sourceDirectory = dirname(sourcePath);
    const { config, dropped } = projectCelldConfig(source);
    const { assets } = source;
    const assetsDirectory = isRecord(assets) && typeof assets["directory"] === "string" ? resolve(sourceDirectory, assets["directory"]) : undefined;
    const mainDirectory = typeof source["main"] === "string" ? dirname(resolve(sourceDirectory, source["main"])) : undefined;
    const root = commonDirectory([sourceDirectory, mainDirectory, assetsDirectory].filter((path): path is string => path !== undefined));

    // celld takes the projection's directory as the project root; for a
    // source entry that has to be the project itself, or `.dev.vars` and every
    // relative path resolve against the wrong directory.
    if (!fromBuild && root !== sourceDirectory) {
        throw new Error(
            `wrangler \`main\` and \`assets.directory\` must sit inside ${sourceDirectory} — celld resolves everything against the config's directory`,
        );
    }

    const rebased = rebaseMigrationDirectories(rebasePaths(config, sourceDirectory, root), own, projectRoot, root);
    const build = fromBuild
        ? adjustBuildOutput(rebased, dropped, own, assetsDirectory, root)
        : { assetsIgnore: undefined, projected: rebased, reported: dropped };
    const projected = purpose === "dev" ? markDevelopment(build.projected) : build.projected;
    const configPath = join(root, CELLD_CONFIG_FILE);
    const contents = `${JSON.stringify(projected, undefined, 4)}\n`;

    return {
        configPath,
        dropped: build.reported,
        write: () => {
            writeFileSync(configPath, contents);

            if (build.assetsIgnore !== undefined) {
                rmSync(build.assetsIgnore);
            }
        },
    };
};

export { planCelldConfig, projectCelldConfig };
