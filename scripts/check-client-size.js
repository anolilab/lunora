#!/usr/bin/env node
/**
 * Weighs what a browser app ships for `@lunora/client` plus one framework
 * adapter, and fails when it grows past a committed ceiling.
 *
 * The browser-side twin of `check-worker-size.js`. Per-package `dist/` sizes
 * answer the wrong question (every entrypoint is a re-export shim over
 * `dist/packem_shared/`), so each adapter gets a tiny reference app — a client,
 * the provider, a live query, a mutation and a subscription — bundled the way a
 * user's Vite build bundles it (Vite 8 / Rolldown, minified). The framework
 * itself (`react`, `vue`, …) is external: the gate measures Lunora's bytes, not
 * React's.
 *
 * Usage:
 *   pnpm run client-size:check     # fail when an app exceeds its ceiling
 *   pnpm run client-size:update    # re-baseline after an intentional change
 *
 * PREREQUISITE: `pnpm run build:packages:prod` — users install the production
 * build, and the development build is heavier.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(rootDir, "client-size.json");
const update = process.argv.includes("--update");

const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const pkg = (name) => JSON.stringify(`@lunora/${name}`);

const ref = (name) => `{ __lunoraRef: ${JSON.stringify(name)} }`;

/**
 * One reference app per adapter. Each uses only what a first app uses: create a
 * client, provide it, read a live query, run a mutation, open a subscription.
 * Everything is parked on `globalThis` so the bundler cannot drop it.
 */
const apps = {
    angular: `import { liveQuery, mutate, provideLunora, subscription } from ${pkg("angular")};
globalThis.app = { providers: [provideLunora()], q: () => liveQuery(${ref("todos:list")}, () => ({})), m: () => mutate(${ref("todos:add")}), s: () => subscription(${ref("todos:list")}, () => ({})) };`,
    react: `import { LunoraClient } from ${pkg("client")};
import { LunoraProvider, useMutation, useQuery, useSubscription } from ${pkg("react")};
const client = new LunoraClient({ url: location.origin });
globalThis.app = { client, LunoraProvider, q: () => useQuery(${ref("todos:list")}, {}), m: () => useMutation(${ref("todos:add")}), s: () => useSubscription(${ref("todos:list")}, {}) };`,
    solid: `import { LunoraClient } from ${pkg("client")};
import { createMutation, createQuery, createSubscription, LunoraProvider } from ${pkg("solid")};
const client = new LunoraClient({ url: location.origin });
globalThis.app = { client, LunoraProvider, q: () => createQuery(${ref("todos:list")}, () => ({})), m: () => createMutation(${ref("todos:add")}), s: () => createSubscription(${ref("todos:list")}, () => ({})) };`,
    svelte: `import { LunoraClient } from ${pkg("client")};
import { mutation, query, setLunoraClient, subscription } from ${pkg("svelte")};
const client = new LunoraClient({ url: location.origin });
globalThis.app = { client, setLunoraClient, q: () => query(${ref("todos:list")}, {}), m: () => mutation(${ref("todos:add")}), s: () => subscription(${ref("todos:list")}, {}) };`,
    vue: `import { LunoraClient } from ${pkg("client")};
import { provideLunora, useMutation, useQuery, useSubscription } from ${pkg("vue")};
const client = new LunoraClient({ url: location.origin });
globalThis.app = { client, provideLunora, q: () => useQuery(${ref("todos:list")}, {}), m: () => useMutation(${ref("todos:add")}), s: () => useSubscription(${ref("todos:list")}, {}) };`,
};

/** Anything that is the app's own framework, not Lunora's weight. */
const external = /^(?:react|react-dom|vue|svelte|solid-js|@angular|@tanstack|rxjs)(?:\/|$)/u;

// Vite is a dependency of `@lunora/vite`, so the gate needs none of its own.
const { build } = await import(pathToFileURL(createRequire(join(rootDir, "packages", "vite", "package.json")).resolve("vite")).href);

/**
 * Link every workspace package into the app's `node_modules`, so the reference
 * apps import by package name and resolve through each `exports` map and
 * `sideEffects` flag exactly as an installed app does. Offline, like the
 * Worker size gate's symlink farm.
 */
const materialize = (appDirectory) => {
    mkdirSync(join(appDirectory, "node_modules", "@lunora"), { recursive: true });

    for (const directory of readdirSync(join(rootDir, "packages"))) {
        const manifest = join(rootDir, "packages", directory, "package.json");

        if (existsSync(manifest)) {
            symlinkSync(join(rootDir, "packages", directory), join(appDirectory, "node_modules", JSON.parse(readFileSync(manifest, "utf8")).name));
        }
    }
};

const measure = async (name, code, workDirectory) => {
    const entry = join(workDirectory, `${name}.mjs`);

    writeFileSync(entry, code, "utf8");

    const output = await build({
        build: { minify: true, rollupOptions: { external: (id) => external.test(id), input: entry }, write: false },
        configFile: false,
        logLevel: "silent",
        root: workDirectory,
    });

    const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output).filter((file) => file.type === "chunk");
    const bytes = Buffer.from(chunks.map((chunk) => chunk.code).join("\n"));

    if (bytes.length < 1024) {
        fail(`check-client-size: the ${name} app bundled to ${bytes.length} bytes — the reference app no longer imports what it should.`);
    }

    return { brotliBytes: brotliCompressSync(bytes).length, gzipBytes: gzipSync(bytes, { level: 9 }).length, rawBytes: bytes.length };
};

const baseline = JSON.parse(readFileSync(fixturePath, "utf8"));
const workDirectory = mkdtempSync(join(tmpdir(), "lunora-client-size-"));
const results = {};

try {
    materialize(workDirectory);

    for (const [name, code] of Object.entries(apps)) {
        results[name] = await measure(name, code, workDirectory);
    }
} finally {
    rmSync(workDirectory, { force: true, recursive: true });
}

const failures = [];

for (const [name, size] of Object.entries(results)) {
    const previous = baseline.apps[name];
    const ceiling = previous ? previous.gzipBytes + baseline.allowanceBytes : Number.POSITIVE_INFINITY;

    process.stdout.write(
        `client size (${name}): ${kib(size.rawBytes)} min, ${kib(size.gzipBytes)} gzip, ${kib(size.brotliBytes)} brotli — ` +
            `baseline ${previous ? kib(previous.gzipBytes) : "none"}, ceiling ${kib(ceiling)}\n`,
    );

    if (!update && size.gzipBytes > ceiling) {
        failures.push(`  ${name}: ${kib(size.gzipBytes)} gzipped, +${kib(size.gzipBytes - previous.gzipBytes)} against the baseline`);
    }
}

if (update) {
    writeFileSync(fixturePath, `${JSON.stringify({ ...baseline, apps: results }, undefined, 4)}\n`, "utf8");
    process.stdout.write("client-size.json updated.\n");
    process.exit(0);
}

if (failures.length > 0) {
    fail(
        `The browser bundle grew past its ceiling (+${kib(baseline.allowanceBytes)} allowance over client-size.json):\n${failures.join("\n")}\n` +
            `Every Lunora web app ships this. Find what arrived, and if the growth is intended, accept it with\n` +
            `\`pnpm run client-size:update\` so the increase is visible in review rather than buried.`,
    );
}
