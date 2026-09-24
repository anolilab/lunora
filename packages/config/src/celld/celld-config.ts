/**
 * The wrangler config as celld accepts it.
 *
 * `celld deploy` / `celld dev` read the project's Wrangler config, but refuse
 * any top-level key outside a fixed list — and Lunora writes several
 * (`observability` from the binding reconciler, `limits` / `version_metadata`
 * from the templates). Rather than keep those keys out of the project's own
 * `wrangler.jsonc`, which Cloudflare still needs, the celld driver deploys a
 * projection of it written beside the original.
 *
 * Beside it, not under `.celld/`: celld takes the config's directory as the
 * project root and requires `main` to sit inside it, so the projected file has
 * to share a directory with the paths it names.
 *
 * The accepted keys track celld v0.5.1's `docs/cloudflare-compat.md`
 * ("Wrangler configuration") and `docs/services/containers.md`.
 */
import { writeFileSync } from "node:fs";

import { findWranglerFile, readWranglerJsonc } from "../cloudflare/wrangler-path";
import type { ProjectedConfig } from "../deploy-driver";
import join from "../path";

/** The projected config's filename, in the project root. */
const CELLD_CONFIG_FILE = ".celld.wrangler.json";

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

/** Migration steps celld refuses: it only ever creates SQLite-backed classes. */
const REFUSED_MIGRATION_STEPS = ["deleted_classes", "new_classes", "renamed_classes", "transferred_classes"];

type Config = Record<string, unknown>;

const isRecord = (value: unknown): value is Config => typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * Project a parsed wrangler config onto what celld accepts.
 * @param config The project's parsed wrangler config.
 * @returns the projected config and every key removed from it.
 * @throws when a migration uses a step celld refuses, or `main` is a Vite
 * virtual module.
 */
const projectCelldConfig = (config: Config): { config: Config; dropped: string[] } => {
    const { main } = config;

    // `celld deploy` bundles `main` with esbuild from source. A Vite virtual
    // entry (`virtual:lunora/worker`) only exists inside a Vite build, so there
    // is no file for esbuild to start from.
    // ponytail: source-entry apps only; a Vite-built worker would need its own
    // path (deploying the build output with `no_bundle`).
    if (typeof main === "string" && main.startsWith("virtual:")) {
        throw new Error(
            `wrangler \`main\` is the Vite virtual module "${main}", which only a Vite build can resolve — celld bundles the worker from a source file with esbuild. Point \`main\` at a worker file (see the standalone template's src/server.ts)`,
        );
    }

    const dropped: string[] = [];
    const projected: Config = {};

    for (const [key, value] of Object.entries(config)) {
        if (!ACCEPTED_KEYS.has(key)) {
            dropped.push(key);

            continue;
        }

        if (key === "migrations") {
            projected[key] = projectMigrations(value);
        } else if (key === "containers") {
            projected[key] = projectContainers(value, dropped);
        } else {
            projected[key] = value;
        }
    }

    return { config: projected, dropped };
};

/**
 * Write the celld projection of the project's wrangler config.
 * @param projectRoot The directory holding `wrangler.jsonc` / `wrangler.json`.
 * @returns where the projection was written and what it left out.
 * @throws when there is no readable wrangler config, or a migration celld refuses.
 */
const writeCelldConfig = (projectRoot: string): ProjectedConfig => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        throw new Error(`no wrangler.jsonc or wrangler.json in ${projectRoot} — celld deploys from the project's Wrangler config`);
    }

    const { parsed } = readWranglerJsonc<Config>(wranglerPath);

    if (parsed === undefined) {
        throw new Error(`${wranglerPath} is not valid JSONC`);
    }

    const { config, dropped } = projectCelldConfig(parsed);
    const configPath = join(projectRoot, CELLD_CONFIG_FILE);

    writeFileSync(configPath, `${JSON.stringify(config, undefined, 4)}\n`);

    return { configPath, dropped };
};

export { CELLD_CONFIG_FILE, projectCelldConfig, writeCelldConfig };
