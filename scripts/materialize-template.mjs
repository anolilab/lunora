/**
 * Materialize a `templates/<name>` app as a runnable project, offline.
 *
 * Templates are not workspaces — their manifests name `^0.0.0` ranges that exist
 * on no registry — so neither `pnpm install` nor a workspace link can make one
 * resolve. This builds the project a user would get, with a symlink farm in
 * place of `node_modules`: the workspace packages by name, and each third-party
 * dependency from whichever workspace package already installed it.
 *
 * Shared by the two consumers that need a template running from source rather
 * than from published tarballs (`scripts/template-build-smoke.sh` packs instead):
 * the Worker size gate (`scripts/check-worker-size.js`) and the saas kit's
 * browser smoke (`tests/e2e/saas-app.mjs`).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace directories whose `node_modules` may already hold a template's third-party dependency. */
const HOST_GROUPS = ["packages", "examples", "apps", "tests"];

/**
 * An installed copy of `name` somewhere in the workspace that satisfies the
 * template's `range`, so the materialized app runs the dependency contract its
 * manifest declares rather than whichever copy happens to be found first. Throws
 * when copies exist but none fits; `undefined` when none is installed at all.
 */
const findInstalled = (name, range) => {
    const found = [];

    for (const group of HOST_GROUPS) {
        for (const directory of readdirSync(join(rootDir, group))) {
            const candidate = join(rootDir, group, directory, "node_modules", name);

            if (existsSync(join(candidate, "package.json"))) {
                const { version } = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));

                if (range === undefined || semver.satisfies(version, range)) {
                    return candidate;
                }

                found.push(version);
            }
        }
    }

    if (found.length > 0) {
        throw new Error(
            `no installed \`${name}\` satisfies the template's "${range}" (the workspace has ${[...new Set(found)].join(", ")}) — align the template's range.`,
        );
    }

    return undefined;
};

/** Link `source` in as `node_modules/<name>`, with its `bin` entries under `.bin`. */
const linkModule = (modules, name, source) => {
    mkdirSync(dirname(join(modules, name)), { recursive: true });
    symlinkSync(source, join(modules, name));

    const { bin } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const bins = typeof bin === "string" ? { [name.split("/").pop()]: bin } : (bin ?? {});

    mkdirSync(join(modules, ".bin"), { recursive: true });

    for (const [command, file] of Object.entries(bins)) {
        if (!existsSync(join(modules, ".bin", command))) {
            symlinkSync(join(source, file), join(modules, ".bin", command));
        }
    }
};

/**
 * Materialize a reference template as a project whose dependencies resolve.
 *
 * A symlink farm rather than an install: every `@lunora/*` dependency is a
 * workspace package that already has its own `node_modules`, so linking the
 * package directories is enough for the bundler to resolve the whole graph — and
 * it keeps the gate offline and quick. `pnpm install` here would try to fetch
 * `lunorash@^0.0.0` from the registry instead. A template's third-party
 * dependencies (React, TanStack, Stripe, Vite…) are linked from whichever
 * workspace package already installed them, so the gate needs none of its own;
 * the version is the workspace's, which is what the template is tested against.
 */
const materializeTemplate = (template, appDirectory, { name: projectName }) => {
    cpSync(join(rootDir, "templates", template), appDirectory, { recursive: true });

    for (const file of ["package.json", "wrangler.jsonc"]) {
        const path = join(appDirectory, file);

        // A D1 binding ships a `<replace-with-d1-create-id>` placeholder, which
        // `lunora build` rightly refuses to ship. Any well-formed id stands in: the
        // bundle does not depend on which database it binds.
        const text = readFileSync(path, "utf8")
            .replaceAll("{{name}}", projectName)
            .replaceAll("<replace-with-d1-create-id>", "00000000-0000-4000-8000-000000000000");

        writeFileSync(path, text, "utf8");
    }

    // The CLI runs wrangler through the project's package manager. A pnpm-shaped
    // project makes `pnpm exec` verify the (absent) lockfile first and abort;
    // `npx --` runs the linked binary directly, so the reference app declares
    // itself npm-shaped with an empty lockfile.
    writeFileSync(join(appDirectory, "package-lock.json"), '{ "lockfileVersion": 3 }\n', "utf8");

    const modules = join(appDirectory, "node_modules");
    const linked = new Set();

    mkdirSync(join(modules, "@lunora"), { recursive: true });

    for (const directory of readdirSync(join(rootDir, "packages"))) {
        const source = join(rootDir, "packages", directory);
        const manifest = join(source, "package.json");

        if (existsSync(manifest)) {
            const { name } = JSON.parse(readFileSync(manifest, "utf8"));

            symlinkSync(source, join(modules, name));
            linked.add(name);
        }
    }

    // wrangler always comes from a workspace package that depends on it: the deploy
    // dry run under `lunora build` needs it whether or not the template lists it.
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(join(appDirectory, "package.json"), "utf8"));
    const wanted = new Set(["wrangler", ...Object.keys(dependencies), ...Object.keys(devDependencies)]);

    for (const name of wanted) {
        if (linked.has(name)) {
            continue;
        }

        const source =
            name === "wrangler"
                ? join(rootDir, "packages", "runtime", "node_modules", "wrangler")
                : findInstalled(name, dependencies[name] ?? devDependencies[name]);

        if (source === undefined) {
            throw new Error(`templates/${template} depends on \`${name}\`, which no workspace package has installed — add it to one.`);
        }

        linkModule(modules, name, source);
        linked.add(name);
    }
};

export { materializeTemplate };
