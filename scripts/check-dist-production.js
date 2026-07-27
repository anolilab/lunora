/**
 * Production-artifact guard.
 *
 * Every `@lunora/*` package has both a `build` (`packem build --development`)
 * and a `build:prod` (`packem build --production`) script. Only `build:prod`
 * output is publishable — a development build keeps the React *dev* JSX runtime
 * (`react/jsx-dev-runtime` / `jsxDEV`), dev-only branches, and no `NODE_ENV`
 * folding. Publishing that breaks any consumer whose bundler stubs or drops the
 * dev runtime in a production build: `jsxDEV is not a function` the moment
 * `<LunoraProvider>` mounts.
 *
 * This shipped for real — `@lunora/react@1.0.0-alpha.31` on npm imports
 * `react/jsx-dev-runtime`, because the release workflow ran `build:packages`
 * (→ `build`) and never `build:prod`. The workflow now runs
 * `build:packages:prod`; this script is the belt to that braces, so a
 * reintroduced dev build fails the release instead of reaching the registry.
 *
 *   node scripts/check-dist-production.js            # all packages with a dist/
 *   node scripts/check-dist-production.js react db   # only these directories
 *
 * Root script: `pnpm run dist:check`. Run it AFTER a build.
 */

import { execFileSync } from "node:child_process";

import { init, parse } from "es-module-lexer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(rootDir, "packages");

/**
 * Markers that only a development build emits. Each is matched literally against
 * every shipped JS file; `why` is what the reader needs in order to act.
 *
 * Know the coverage limit before trusting a green run: every marker here is a
 * React dev-JSX tell, so this proves the React-family packages (`react`,
 * `react-native`, `studio`, …) were built for production and proves nothing about
 * the rest. A dev build of a package that emits no JSX — unminified, with
 * `NODE_ENV` branches unfolded — passes clean. Widening this list to catch that
 * means a different kind of check (bundle-size or `process.env.NODE_ENV`
 * residue), not another literal.
 */
const DEV_MARKERS = [
    { marker: "react/jsx-dev-runtime", why: "React dev JSX runtime import — production bundlers may stub this to undefined" },
    { marker: "jsxDEV", why: "React dev JSX factory call" },
    { marker: "react/jsx-dev-runtime.js", why: "React dev JSX runtime import" },
];

/** Extensions that are executed by a consumer (declarations can't crash at runtime). */
const isRuntimeFile = (name) => /\.(?:mjs|cjs|js)$/.test(name) && !name.endsWith(".d.ts");

const walk = (dir) => {
    const out = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            out.push(...walk(full));
        } else if (entry.isFile() && isRuntimeFile(entry.name)) {
            out.push(full);
        }
    }

    return out;
};

const dirExists = (path) => {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
};

const requested = process.argv.slice(2);
const packageDirs = (requested.length > 0 ? requested : readdirSync(packagesDir)).filter((name) => dirExists(join(packagesDir, name)));

const violations = [];
let checkedPackages = 0;
let checkedFiles = 0;

for (const name of packageDirs) {
    const distDir = join(packagesDir, name, "dist");

    if (!dirExists(distDir)) {
        continue;
    }

    checkedPackages += 1;

    for (const file of walk(distDir)) {
        checkedFiles += 1;

        const source = readFileSync(file, "utf8");

        for (const { marker, why } of DEV_MARKERS) {
            if (source.includes(marker)) {
                violations.push({ file: relative(rootDir, file), marker, package: name, why });
                break;
            }
        }
    }
}

if (checkedPackages === 0) {
    console.error("❌ No package dist/ directories found — run a build first (`pnpm run build:packages:prod`).");
    process.exit(1);
}

/**
 * The built CLI must report its real version.
 *
 * `@lunora/cli` reads its own `package.json` at load time to answer `--version`
 * (and to decide whether to check for updates). That read is relative to the
 * built module, whose depth packem chooses — so a re-chunk can silently move the
 * manifest out of reach and every published build falls back to the `0.0.0` dev
 * sentinel. That shipped: alpha.116's binary reported `0.0.0`.
 *
 * No unit test can catch it, because from `src/` under vitest the manifest is
 * always exactly where the resolver looks. Only the artifact shows the bug, so
 * the check belongs here.
 */
const checkCliVersion = () => {
    const cliDir = join(packagesDir, "cli");
    const binary = join(cliDir, "dist", "bin.mjs");

    if (!dirExists(join(cliDir, "dist"))) {
        return true;
    }

    const { version } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
    let reported;

    try {
        reported = execFileSync(process.execPath, [binary, "--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    } catch (error) {
        console.error(`❌ Could not run the built CLI (${relative(rootDir, binary)}): ${error.message}`);

        return false;
    }

    if (!reported.includes(version)) {
        console.error(`❌ The built CLI reports "${reported}" but its package.json says "${version}".`);
        console.error("   `readCliVersion` in packages/cli/src/cli.ts can no longer find the manifest from the built module.");

        return false;
    }

    console.log(`✅ The built CLI reports its real version (${version}).`);

    return true;
};

/**
 * `@lunora/mcp/docs` must stay runnable off Node.
 *
 * The whole shape of `packages/mcp/src/docs/` — and the `serve-stateless.ts` and
 * `tool-types.ts` splits that support it — exists so a docs site can serve the
 * documentation tools from a Worker or an edge function. One `import … from
 * "../server"` reintroduces the `node:fs` read that entry does at module scope,
 * and one from `../tools` drags in `@lunora/client`. Either breaks the deploy
 * with no failing test and no lint error, because both are perfectly legal
 * TypeScript.
 *
 * So assert it where it is actually observable: in the emitted chunk graph.
 */
const BARE_NODE_BUILTINS = new Set([
    "assert",
    "buffer",
    "child_process",
    "crypto",
    "events",
    "fs",
    "http",
    "https",
    "net",
    "os",
    "path",
    "stream",
    "tls",
    "url",
    "util",
    "zlib",
]);

/** Why a given import specifier disqualifies the chunk graph from running on an edge runtime. */
const edgeUnsafeReason = (specifier) => {
    if (specifier.startsWith("node:") || BARE_NODE_BUILTINS.has(specifier)) {
        // The bare form matters: `import "fs"` is legal Node and NOT edge-safe —
        // Workers requires the `node:` prefix even with nodejs_compat.
        return "a Node built-in — unavailable on Workers and most edge runtimes";
    }

    return specifier === "@lunora/client" ? "the deployment client — the docs surface must not depend on it" : undefined;
};

/**
 * Every file `entry` pulls in, following relative imports transitively.
 *
 * Parsed with `es-module-lexer` rather than matched with regexes: the input is
 * emitted, sometimes minified, bundler output, where all three edge forms —
 * a `from` clause, a bare side-effect `import "./x"`, and a dynamic
 * `import("./x")` — appear without the whitespace a pattern would key on.
 * Missing one lets an unsafe chunk hide a hop behind it.
 */
const chunkGraph = async (entry) => {
    await init;

    const seen = new Set();
    const queue = [entry];

    while (queue.length > 0) {
        const file = queue.pop();

        if (seen.has(file)) {
            continue;
        }

        seen.add(file);

        const [imports] = parse(readFileSync(file, "utf8"), file);

        for (const record of imports) {
            // `n` is undefined for a dynamic import with a computed specifier,
            // which we cannot resolve statically anyway.
            if (record.n !== undefined && record.n.startsWith(".")) {
                queue.push(join(dirname(file), record.n));
            }
        }
    }

    return seen;
};

const checkDocsEntryIsEdgeSafe = async () => {
    const entry = join(packagesDir, "mcp", "dist", "docs", "index.mjs");

    if (!dirExists(join(packagesDir, "mcp", "dist"))) {
        return true;
    }

    let files;

    try {
        files = await chunkGraph(entry);
    } catch (error) {
        console.error(`❌ Could not walk the @lunora/mcp/docs chunk graph from ${relative(rootDir, entry)}: ${error.message}`);

        return false;
    }

    const found = [];

    for (const file of files) {
        // Parsed records, not a substring scan: the literal `node:` in a comment
        // or a data string is not an import, and a real one can be written with
        // either quote style.
        const [imports] = parse(readFileSync(file, "utf8"), file);

        for (const record of imports) {
            const why = record.n === undefined ? undefined : edgeUnsafeReason(record.n);

            if (why !== undefined) {
                found.push({ file: relative(rootDir, file), specifier: record.n, why });
            }
        }
    }

    if (found.length > 0) {
        console.error("❌ @lunora/mcp/docs pulls in code that cannot run on an edge runtime:\n");

        for (const entryFound of found) {
            console.error(`  ${entryFound.file}`);
            console.error(`    ${entryFound.specifier} — ${entryFound.why}`);
        }

        console.error("\nThe /docs entry must not import from `src/server.ts`, `src/tools.ts`, or anything reaching a Node built-in.");

        return false;
    }

    console.log(`✅ @lunora/mcp/docs stays edge-safe across ${files.size} emitted chunk(s).`);

    return true;
};

const cliVersionOk = checkCliVersion();
const docsEntryOk = await checkDocsEntryIsEdgeSafe();

if (violations.length > 0) {
    console.error(`❌ Development-build artifacts found in ${violations.length} file(s):\n`);

    for (const violation of violations) {
        console.error(`  ${violation.file}`);
        console.error(`    ${violation.marker} — ${violation.why}`);
    }

    console.error("\nThese packages were built with `build` (--development) instead of `build:prod` (--production).");
    console.error("Rebuild with `pnpm run build:packages:prod` before publishing.");
    process.exit(1);
}

if (!cliVersionOk || !docsEntryOk) {
    process.exit(1);
}

console.log(`✅ ${checkedFiles} shipped file(s) across ${checkedPackages} package(s) carry no development-build markers.`);
